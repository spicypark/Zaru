from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from zaru.config import Settings, get_settings
from zaru.telemetry import setup_telemetry

MODES = ("see", "hear")


def _redirect_to(path: str):
    # The handler takes no parameters, so FastAPI can't bind request input to the target
    # (a lambda default argument would become a query parameter: an open redirect).
    async def redirect() -> RedirectResponse:
        return RedirectResponse(path, status_code=308)

    return redirect


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="Zaru", docs_url=None, redoc_url=None)
    setup_telemetry(app, settings)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    static_dir = settings.static_dir
    if static_dir.is_dir():
        # /see and /hear are separate HTML entries (each with its own manifest, so each can be
        # added to the home screen as its own icon). Normalise the bare path to the directory.
        for mode in MODES:
            app.add_api_route(f"/{mode}", _redirect_to(f"/{mode}/"), include_in_schema=False)
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="web")
    else:

        @app.get("/", include_in_schema=False)
        async def no_build() -> dict[str, str]:
            return {"status": "ok", "detail": "web build not found; run `npm run build` in web/"}

    return app


app = create_app()
