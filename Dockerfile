# --- Stage 1: build the PWA ---
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Railway passes service variables to declared build args. These are baked into the bundle,
# so VITE_DASH0_AUTH_TOKEN must be an ingest-only token.
ARG VITE_DASH0_ENDPOINT
ARG VITE_DASH0_AUTH_TOKEN
ARG VITE_DASH0_DATASET
RUN npm run build

# --- Stage 2: Python runtime serving the API and the built PWA ---
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1
COPY server/pyproject.toml server/uv.lock server/.python-version ./
RUN uv sync --frozen --no-dev
COPY server/zaru ./zaru
COPY --from=web /web/dist ./static
ENV STATIC_DIR=/app/static \
    PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn zaru.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
