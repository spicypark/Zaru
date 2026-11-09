# Zaru

Zaru turns a phone into a live accessibility companion for conferences. **Zaru See** tells blind and low-vision attendees what's happening around them, and **Zaru Hear** puts real-time speech bubbles above whoever is talking so deaf and hard-of-hearing attendees can follow hallway conversations.

Built at the WeMakeDevs Cloud Native Hackathon (Salt Lake City, Nov 9 2026).

**Live:** https://zaru.jerryzheng.dev

## Features

- **Zaru See:** announces only what changes: hazards first, then people approaching, readable signs, then the scene, with clock-face directions. Two full-screen buttons: *Describe what's around me* and *Ask a question*. Works with VoiceOver.
- **Zaru Hear:** tracks faces on-device, works out who is speaking from mouth movement, and anchors live captions above that person. Speech it can't attribute goes to a caption bar.
- Runs in the browser on iPhone (add to home screen) and on laptops (webcam + mic). No app store install.
- **Privacy:** no audio, video frames or transcripts are stored, and telemetry contains only timings and counts.

## Open Zaru See quickly (iPhone)

1. In Safari, open `https://zaru.jerryzheng.dev/see/`, then Share → **Add to Home Screen**. This creates a **Zaru See** icon that opens straight into See mode. Do the same with `/hear/` for **Zaru Hear**.
2. For hands-free launch, open the Shortcuts app → **+** → *Open URLs* → `https://zaru.jerryzheng.dev/see/`, then name the shortcut **Zaru**.
   - Say **"Hey Siri, Zaru"**, or
   - Go to Settings → Accessibility → Touch → **Back Tap** → Triple Tap → *Zaru* to launch it by tapping the back of the phone.

Zaru also remembers the last mode you used and reopens it.

## Architecture

```
Browser PWA (React + MediaPipe, on-device face/object tracking)
   │  HTTPS + WebSocket (same origin)
   ▼
FastAPI on Railway ──► OpenAI (realtime transcription, vision)
   │
   └─ OpenTelemetry + OpenLIT ──► Dash0 (traces, metrics, logs; browser RUM via Dash0 Web SDK)
```

| Part | Stack |
|---|---|
| Web | Vite, React, TypeScript, MediaPipe Tasks Vision, Web Audio, `speechSynthesis` |
| Server | Python 3.12, uv, FastAPI, uvicorn, OpenAI SDK |
| Observability | OpenTelemetry (OTLP/HTTP), OpenLIT, Dash0 |
| Hosting | Railway (single Dockerfile service) |
| Code review | Gitar (`.gitar/review/`) + GitHub Actions CI |

## Run locally

Requirements: Node 24+, [uv](https://docs.astral.sh/uv/).

```bash
cp .env.example server/.env        # fill in OPENAI_API_KEY etc.
cd server && uv sync && uv run uvicorn zaru.main:app --reload --port 8000
```

In another terminal:

```bash
cd web && npm install && npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/ws` to the backend. Browsers only allow camera access on `localhost` or HTTPS, so to test on a phone, use a tunnel such as `cloudflared tunnel --url http://localhost:5173`.

Checks (the same ones CI runs):

```bash
cd web && npm run typecheck && npm run lint && npm run build
cd server && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

## Configuration

See [`.env.example`](.env.example). Server variables go in `server/.env` or Railway service variables. `VITE_*` variables are compiled into the web bundle at build time, so use an ingest-only Dash0 token there.

## Deploy (Railway)

The root `Dockerfile` builds the PWA, then runs FastAPI, which serves both the app and the API. Set the variables from `.env.example` on the Railway service, connect the custom domain, and every merge to `main` deploys.

## AI usage disclosure

This project was built with the help of an AI coding assistant (Claude Code). All code was reviewed, tested and directed by the team, and pull requests were reviewed by Gitar.
