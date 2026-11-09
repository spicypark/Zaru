# Zaru

Zaru turns a phone into a live accessibility companion for conferences. **Zaru See** tells blind and low-vision attendees what's happening around them, and **Zaru Hear** puts real-time speech bubbles above whoever is talking so deaf and hard-of-hearing attendees can follow hallway conversations.

Built at the WeMakeDevs Cloud Native Hackathon (Salt Lake City, Nov 9 2026).

**Live:** https://zaru.jerryzheng.dev

## Features

### Zaru See (blind and low-vision)

- **Continuous narration.** Zaru watches the camera on the phone itself and asks the vision model for an update only when the view really changes, when you've been walking for a while, or as a short "Still …" reminder after a long quiet stretch (reminders space out from 20 s to 60 s). It speaks one short sentence about something *new*: hazards first, then people, doors and stairs, readable signs, then the scene. Directions are given as clock positions. The model sees what it said recently, so it doesn't repeat itself, and it is told to describe only what is clearly in the frame. If the camera is pointed at a table, Zaru says so instead of inventing a room.
- **Approaching-person alerts.** An on-device MediaPipe person detector notices someone walking towards you and says which way they are coming from, without waiting for the vision model.
- **Ask a question.** Tap *Ask*, speak, and tap again to send. Your question and the current frame go to the server, which transcribes the question and answers it from what is visible. The mic opens only while you are asking, because on iPhone an open mic switches audio to call mode and cuts off speech. Narration pauses until the answer has been spoken.
- **Built for no sight.** There's a big Start/Pause button, short earcons (generated sounds) for recording and thinking, an adjustable speech rate, and a screen wake lock so the camera keeps running. If the camera freezes, Zaru reopens it automatically. A coloured flash around the edge of the screen (a different colour for each kind of update) shows sighted helpers when Zaru speaks. Works with VoiceOver. On a laptop, **Space** pauses or resumes, **Enter** asks a question and **Esc** stops speech.

### Zaru Hear (deaf and hard of hearing)

- **Speech bubbles on the speaker.** MediaPipe Face Landmarker tracks faces on the device and measures mouth movement to work out who is talking. Each caption is anchored in a bubble above that person. Words that are still streaming in follow whoever's mouth is moving right now. Speech it can't attribute to a face goes to a caption bar, so nothing is dropped.
- **Live captions.** Audio streams continuously over a WebSocket to OpenAI realtime transcription, with a vocabulary hint for conference terms (Kubernetes, eBPF, OpenTelemetry, Dash0, …). An adaptive speech gate on the phone uses a percentile noise floor with hysteresis, so it keeps hearing speech during a continuous conversation instead of going deaf.
- **Works without OpenAI.** If there's no key, the key is rejected or the network is down, the server falls back to a local `faster-whisper` model (`small.en`, baked into the Docker image). The status bar then shows *Local captions*.
- Every final caption is also sent to a screen-reader live region for braille users. You can flip between the front and back cameras without stopping captions. Add `?debug=1` to show face boxes, mouth-activity bars and the mic level against the gate.

### Both modes

- Runs in the browser on iPhone (add it to the home screen) and on laptops (webcam and mic). Nothing to install from an app store. The MediaPipe models and WASM runtime are served by the app itself, so there's no CDN dependency.
- **Privacy:** no audio, video frames or transcripts are stored or logged. Telemetry contains only timings, counts and fixed labels.

## Recommended way to run Zaru (iPhone)

1. In Safari, open `https://zaru.jerryzheng.dev/`, then Share → **Add to Home Screen**. This creates a **Zaru** icon that opens into the mode select, either See or Hear.
2. For hands-free launch, open the Shortcuts app → **+** → *Open URLs* → `https://zaru.jerryzheng.dev/`, then name the shortcut **Zaru**.
   - Say **"Hey Siri, Zaru"**, or
   - Go to Settings → Accessibility → Touch → **Back Tap** → Triple Tap → *Zaru* to launch it by tapping the back of the phone.

`https://zaru.jerryzheng.dev/` always opens the mode picker. `/see/` and `/hear/` (and their home-screen icons) open a mode directly.

## Architecture

```
Browser PWA (React + MediaPipe, on-device face/object tracking)
   │  HTTPS + WebSocket (same origin)
   ▼
FastAPI on Railway ──► OpenAI (realtime transcription, vision)
   │   └─ fallback: local faster-whisper captions (no key / OpenAI down)
   │
   └─ OpenTelemetry + OpenLIT ──► Dash0 (traces, metrics, logs; browser RUM via Dash0 Web SDK)
```

| Part | Stack |
|---|---|
| Web | Vite, React, TypeScript, MediaPipe Tasks Vision (face landmarker, EfficientDet person detector), Web Audio (AudioWorklet mic capture), `speechSynthesis`, Dash0 Web SDK |
| Server | Python 3.12, uv, FastAPI, uvicorn, OpenAI SDK, faster-whisper |
| Observability | OpenTelemetry (OTLP/HTTP), OpenLIT, Dash0 |
| Hosting | Railway (single Dockerfile service) |
| Code review | Gitar with project rules for accessibility, privacy, realtime/telemetry and secrets (`.gitar/review/`), plus GitHub Actions CI |

## Run locally

Requirements: Node 24+, [uv](https://docs.astral.sh/uv/).

```bash
cp .env.example server/.env        # fill in OPENAI_API_KEY etc. (VITE_* vars go in web/.env.local)
cd server && uv sync && uv run uvicorn zaru.main:app --reload --port 8000
```

In another terminal:

```bash
cd web && npm install && npm run dev
```

Open http://localhost:5173. `npm run dev` and `npm run build` first fetch the MediaPipe models into `web/public/mediapipe/`. The Vite dev server proxies `/api` and `/ws` to the backend. Browsers only allow camera access on `localhost` or HTTPS, so to test on a phone, use a tunnel such as `cloudflared tunnel --url http://localhost:5173`.

No OpenAI key? Hear still works: the server falls back to local Whisper captions (the model downloads on first use; set `TRANSCRIPTION_BACKEND=local` to force it). See needs OpenAI for vision.

Checks (the same ones CI runs):

```bash
cd web && npm run typecheck && npm run lint && npm run build
cd server && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

## Configuration

See [`.env.example`](.env.example). Server variables go in `server/.env` or Railway service variables. `VITE_*` variables are compiled into the web bundle at build time, so use an ingest-only Dash0 token there.

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_VISION_MODEL` | `gpt-4.1-mini` | See narration and answers (picked by measurement: about 2 s per frame, no invented details) |
| `OPENAI_LIVE_TRANSCRIBE_MODEL` / `OPENAI_TRANSCRIBE_MODEL` | `gpt-live-transcribe` / `gpt-transcribe` | Hear captions / See questions |
| `TRANSCRIPTION_BACKEND` | `auto` | `auto` (OpenAI, local fallback), `openai` or `local` |
| `LOCAL_WHISPER_MODEL` | `small.en` | Local caption model |

## Observability (Dash0)

The server exports traces, metrics and logs over OTLP. OpenLIT instruments the OpenAI calls, and custom metrics cover vision latency, See announcements by priority and local Whisper duration. The browser sends RUM through the Dash0 Web SDK: web vitals, errors, fetches and frustration signals, plus product events such as See time-to-speech, Hear caption latency and attribution (face or caption bar), face-detector FPS, camera restarts and socket reconnects. Session recording is off because the screen shows people, and events carry only numbers and fixed labels.

## Deploy (Railway)

The root `Dockerfile` builds the PWA, bakes the Whisper model into the image, then runs FastAPI, which serves both the app and the API (`/healthz` for health checks). Set the variables from `.env.example` on the Railway service, connect the custom domain, and every merge to `main` deploys.

## AI usage disclosure

This project was built with the help of an AI coding assistant (Claude Code). All code was reviewed, tested and directed by the team, and pull requests were reviewed by Gitar.
