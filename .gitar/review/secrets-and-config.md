# Secrets and configuration

Apply alongside the standard review.

- `OPENAI_API_KEY` and the server Dash0 token (`OTEL_EXPORTER_OTLP_HEADERS`) must only be read on the server (`server/zaru/config.py` settings). Flag as **blocking** any code in `web/` that references an OpenAI key, calls `api.openai.com` directly, or ships a server token to the browser.
- Anything prefixed `VITE_` is baked into the public JavaScript bundle. Only `VITE_DASH0_ENDPOINT`, `VITE_DASH0_AUTH_TOKEN` (an ingest-only token) and `VITE_DASH0_DATASET` are allowed. Flag any new `VITE_` variable that holds a secret.
- New settings go through the `Settings` class in `server/zaru/config.py` and must be added to `.env.example` with an empty or placeholder value. Flag hard-coded keys, tokens, model names or URLs that should be configurable.
- `.env` files must never be committed.
