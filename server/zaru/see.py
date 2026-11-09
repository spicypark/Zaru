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

SYSTEM_PROMPT = """You are Zaru See, the eyes of a blind attendee at a tech conference, looking \
through their phone's back camera held in front of them. Your words are read aloud, so:
- Be brief and concrete. No preamble, no "I see", no "the image shows".
- Give directions as clock positions from the user. The camera points at 12 o'clock, so \
everything in the frame is in front of them: left edge of the image = 10 o'clock, centre = 12, \
right edge = 2. Never use 3 to 9 o'clock. Add rough distance in steps or metres (lower in the \
frame = closer).
- Priority: hazards (steps, stairs, obstacles at body or head height, wet floor, doors \
swinging, cables, low tables) > people (how many, where, approaching or not, what they're \
doing) > readable text (room signs, slide titles, badges, arrows: quote it exactly) > the \
general scene.
- Never guess names or identities from faces; you may read a visible name badge.
- If you're not sure something is there, don't say it."""

AUTO_INSTRUCTIONS = """This frame was captured automatically because the camera view changed. \
The last thing you told the user was: "{previous}".
Set changed to true ONLY for something the user would want to be interrupted for: a new hazard, \
a person appearing, approaching or leaving, new readable text (a sign, slide or badge), or \
arriving somewhere different. Changes in pose, gesture, expression, clothing details, lighting or \
camera angle are NOT changes. When in doubt, changed is false and speak is empty.
If changed, `speak` is at most 2 short sentences about only the new thing."""

DESCRIBE_INSTRUCTIONS = """The user asked: "Describe what's around me." Give a complete but \
brief description: `speak` is at most 3 short sentences, most important first. changed is true."""

ASK_INSTRUCTIONS = """The user asked about this view: "{question}". Answer the question directly \
in `speak`, at most 3 short sentences. If the answer isn't visible, say so plainly and suggest \
where to point the camera. changed is true."""


class Scene(BaseModel):
    hazards: list[str] = Field(description="Hazards with clock direction and distance")
    people: list[str] = Field(description="People with clock direction, distance and activity")
    text: list[str] = Field(description="Readable text, quoted exactly")
    scene: str = Field(description="One-sentence summary of the whole view, for memory")
    changed: bool
    priority: Literal["hazard", "people", "text", "scene", "none"]
    speak: str = Field(description="What to say aloud, following the length limit")


class DescribeRequest(BaseModel):
    image: str  # data URL or bare base64 JPEG
    mode: Literal["auto", "describe"] = "describe"
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


def get_openai(settings: Settings) -> AsyncOpenAI:
    if not settings.openai_api_key or not settings.openai_vision_model:
        raise HTTPException(503, "scene descriptions are not configured")
    return _client(settings.openai_api_key)


async def describe_scene(
    client: AsyncOpenAI, settings: Settings, jpeg: bytes, instructions: str, mode: str
) -> Scene:
    # Automatic checks use the fast low-detail image; the user's own requests get full detail
    # so small text is readable.
    detail = "low" if mode == "auto" else "auto"
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
    return SeeResponse(
        speak=speak, priority=priority, changed=bool(speak), scene=scene.scene, question=question
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
            if req.mode == "auto":
                previous = req.previous.strip()[:400] or "nothing yet"
                instructions = AUTO_INSTRUCTIONS.format(previous=previous)
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
