"""See mode: scene understanding for blind and low-vision attendees.

POST /api/see/describe  {image, mode: "auto" | "describe", previous, reason}
    "auto" is sent by the phone when its on-device change detector fires; the model is told what
    it said last time and only reports what changed (`changed: false` = say nothing).
    "describe" is the user pressing "Describe what's around me": always a full description.
POST /api/see/ask       {image, audio}
    A spoken question (WAV) about the current frame: transcribed, then answered.

Frames and audio are processed in memory and never stored or logged; telemetry records only
timings, sizes, modes and the model's priority label.
"""

import base64
import binascii
import io
import logging
import time
from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, HTTPException
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from zaru.config import Settings
from zaru.local_stt import VOCABULARY_PROMPT
from zaru.telemetry import meter, tracer

log = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 2_000_000
MAX_AUDIO_BYTES = 24_000 * 2 * 20 + 44  # 20 s of 24 kHz PCM16 WAV

vision_latency = meter.create_histogram(
    "zaru.see.vision_latency_ms", unit="ms", description="Vision model call duration, by mode"
)
see_requests = meter.create_counter(
    "zaru.see.requests", description="See mode requests, by mode and outcome"
)
announcements = meter.create_counter(
    "zaru.see.announcements", description="What the model chose to announce, by priority"
)

# Grounding matters more than anything else here: a blind user can't check the answer. Earlier
# prompts that named a setting ("a tech conference") and listed example hazards and signs made
# the model invent exactly those (people, room signs, wet-floor signs) on featureless frames such
# as a close-up of a table. So: no assumed setting, no example objects, and the model must first
# write down literally what is in the frame before deciding what to say.
SYSTEM_PROMPT = """You describe live camera frames for a blind person. The phone's back camera \
is held in front of them. Your `speak` text is read aloud to them.

Accuracy rules (most important):
- Describe ONLY what is clearly visible in this exact photo. Never assume a setting, an event or \
objects that aren't plainly shown.
- Never invent people, signs, text, screens or hazards. Only quote text you can actually read in \
the photo, exactly as written.
- Many frames are ordinary or close-up: a table top, a wall, the floor, a hand, a blurry or dark \
view. Say exactly that, plainly (for example, that the camera is pointed at a surface up close). \
That is a correct and useful answer.
- If the photo is too dark or blurry to tell, say so and suggest moving the camera.
- Never identify people by face; you may read a visible name badge.

Style: brief and concrete, no preamble ("I see", "the image shows"). Directions are clock \
positions from the user: the camera points at 12 o'clock, the left edge of the frame is 10 and \
the right edge is 2 (never 3 to 9). Lower in the frame means closer. Order: hazards, then people, \
then readable text, then everything else."""

AUTO_INSTRUCTIONS = """This frame was captured automatically because the camera view changed. \
The last thing you told the user was: "{previous}".
Set changed to true only if this photo clearly shows something new the user would want to be \
interrupted for: an obstacle or drop in their path, a person, readable text, or a different \
place. Ordinary surfaces, close-ups, blur, pose, lighting or camera angle are not worth \
interrupting for. When in doubt, changed is false and speak is empty.
If changed, `speak` is at most 2 short sentences about only the new thing."""

UPDATE_INSTRUCTIONS = """This is a running narration for a blind person who may be walking with \
the camera. A moment ago you told them: "{previous}".
Speak about this photo: lead with anything new or urgent (an obstacle or drop in their path, a \
person close by, readable text), then briefly what is in front of them. If the view is \
essentially the same as before, give one short reminder sentence of what is in front of them and \
set changed to false; otherwise changed is true. `speak` is at most 2 short sentences."""

DESCRIBE_INSTRUCTIONS = """The user asked: "Describe what's around me." Describe what this photo \
actually shows, in at most 3 short sentences, most important first. changed is true."""

ASK_INSTRUCTIONS = """The user asked about this view: "{question}". Answer from what is visible \
in this photo only, in at most 3 short sentences. If the answer isn't visible, say so plainly \
and suggest where to point the camera. changed is true."""


class Scene(BaseModel):
    # Field order is deliberate: the literal inventory comes first, so the later fields (and what
    # gets spoken) are conditioned on what was actually observed.
    visible: str = Field(
        description="Literal, plain inventory of what is in this photo and nothing else"
    )
    hazards: list[str] = Field(
        description="Obstacles or drops clearly visible in the user's path, with clock direction "
        "and distance; empty if none"
    )
    people: list[str] = Field(
        description="People clearly visible, with clock direction and distance; empty if none"
    )
    text: list[str] = Field(description="Text legible in the photo, quoted exactly; empty if none")
    scene: str = Field(description="One-sentence summary of this view, for memory")
    changed: bool
    priority: Literal["hazard", "people", "text", "scene", "none"]
    speak: str = Field(description="What to say aloud, following the length limit")


class DescribeRequest(BaseModel):
    image: str  # data URL or bare base64 JPEG
    # update: continuous narration (always spoken; `changed` tells the phone whether to slow down)
    # auto: speak only if something changed; describe: full description on request
    mode: Literal["update", "auto", "describe"] = "describe"
    previous: str = ""
    reason: str = ""


class AskRequest(BaseModel):
    image: str
    audio: str  # base64 WAV, mono PCM16


class SeeResponse(BaseModel):
    speak: str
    priority: str
    changed: bool
    scene: str
    question: str | None = None


def _decode(data: str, limit: int, what: str) -> bytes:
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(400, f"invalid {what}") from exc
    if not raw or len(raw) > limit:
        raise HTTPException(413 if raw else 400, f"{what} too large or empty")
    return raw


@lru_cache
def _client(api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(api_key=api_key)


# Reasoning models (o-series, gpt-5 family) reject `temperature`; the rest get 0 for the most
# literal, repeatable descriptions.
_REASONING_PREFIXES = ("o1", "o3", "o4", "gpt-5")


def _sampling_options(model: str) -> dict:
    if model.startswith(_REASONING_PREFIXES):
        return {}
    return {"temperature": 0}


def get_openai(settings: Settings) -> AsyncOpenAI:
    if not settings.openai_api_key or not settings.openai_vision_model:
        raise HTTPException(503, "scene descriptions are not configured")
    return _client(settings.openai_api_key)


async def describe_scene(
    client: AsyncOpenAI, settings: Settings, jpeg: bytes, instructions: str, mode: str
) -> Scene:
    # Full detail for every request: low-detail images measurably increased invented details.
    detail = "auto"
    image_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
    with tracer.start_as_current_span("zaru.vision.describe") as span:
        span.set_attribute("zaru.see.mode", mode)
        span.set_attribute("zaru.vision.model", settings.openai_vision_model)
        span.set_attribute("zaru.image.bytes", len(jpeg))
        started = time.monotonic()
        response = await client.responses.parse(
            model=settings.openai_vision_model,
            instructions=SYSTEM_PROMPT,
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": instructions},
                        {"type": "input_image", "image_url": image_url, "detail": detail},
                    ],
                }
            ],
            text_format=Scene,
            **_sampling_options(settings.openai_vision_model),
        )
        vision_latency.record((time.monotonic() - started) * 1000, {"mode": mode})
        scene = response.output_parsed
        if scene is None:
            raise HTTPException(502, "no description")
        span.set_attribute("zaru.see.priority", scene.priority)
        span.set_attribute("zaru.see.changed", scene.changed)
        return scene


def _result(scene: Scene, mode: str, question: str | None = None) -> SeeResponse:
    speak = scene.speak.strip() if (scene.changed or mode != "auto") else ""
    priority = scene.priority if speak else "none"
    announcements.add(1, {"priority": priority, "mode": mode})
    # In update mode everything is spoken; `changed` is the model's "something is new" signal,
    # which the phone uses to speed up or slow down its narration.
    changed = scene.changed if mode == "update" else bool(speak)
    return SeeResponse(
        speak=speak, priority=priority, changed=changed, scene=scene.scene, question=question
    )


def create_see_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/api/see")

    @router.post("/describe")
    async def describe(req: DescribeRequest) -> SeeResponse:
        jpeg = _decode(req.image, MAX_IMAGE_BYTES, "image")
        client = get_openai(settings)
        with tracer.start_as_current_span("zaru.see.describe") as span:
            span.set_attribute("zaru.see.mode", req.mode)
            span.set_attribute("zaru.see.reason", req.reason[:40])
            previous = req.previous.strip()[:400] or "nothing yet"
            if req.mode == "auto":
                instructions = AUTO_INSTRUCTIONS.format(previous=previous)
            elif req.mode == "update":
                instructions = UPDATE_INSTRUCTIONS.format(previous=previous)
            else:
                instructions = DESCRIBE_INSTRUCTIONS
            try:
                scene = await describe_scene(client, settings, jpeg, instructions, req.mode)
            except HTTPException:
                see_requests.add(1, {"mode": req.mode, "outcome": "error"})
                raise
            except Exception as exc:
                see_requests.add(1, {"mode": req.mode, "outcome": "error"})
                log.warning("vision call failed: %s", type(exc).__name__)
                raise HTTPException(502, "vision unavailable") from exc
            see_requests.add(1, {"mode": req.mode, "outcome": "ok"})
            return _result(scene, req.mode)

    @router.post("/ask")
    async def ask(req: AskRequest) -> SeeResponse:
        jpeg = _decode(req.image, MAX_IMAGE_BYTES, "image")
        wav = _decode(req.audio, MAX_AUDIO_BYTES, "audio")
        client = get_openai(settings)
        with tracer.start_as_current_span("zaru.see.ask") as span:
            span.set_attribute("zaru.audio.bytes", len(wav))
            try:
                with tracer.start_as_current_span("zaru.see.ask.transcribe"):
                    transcript = await client.audio.transcriptions.create(
                        model=settings.openai_transcribe_model,
                        file=("question.wav", io.BytesIO(wav), "audio/wav"),
                        prompt=VOCABULARY_PROMPT,
                    )
                question = (transcript.text or "").strip()
                if not question:
                    see_requests.add(1, {"mode": "ask", "outcome": "no_question"})
                    return SeeResponse(
                        speak="I didn't catch a question. Try again.",
                        priority="none",
                        changed=True,
                        scene="",
                        question="",
                    )
                scene = await describe_scene(
                    client, settings, jpeg, ASK_INSTRUCTIONS.format(question=question), "ask"
                )
            except HTTPException:
                see_requests.add(1, {"mode": "ask", "outcome": "error"})
                raise
            except Exception as exc:
                see_requests.add(1, {"mode": "ask", "outcome": "error"})
                log.warning("ask failed: %s", type(exc).__name__)
                raise HTTPException(502, "ask unavailable") from exc
            see_requests.add(1, {"mode": "ask", "outcome": "ok"})
            return _result(scene, "ask", question=question)

    return router
