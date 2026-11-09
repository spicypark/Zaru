# Realtime pipeline and telemetry conventions

Apply alongside the standard review to `server/zaru/` and `web/src/`.

**Realtime resources**

- Every WebSocket handler that opens an upstream OpenAI connection must close it when the client disconnects or errors (use `try`/`finally` or an async context manager). Flag leaks as **blocking**.
- Never block the event loop in async server code: no synchronous HTTP clients, `time.sleep`, or CPU-heavy work inside `async def` handlers.
- Browser code that opens camera/mic streams, WebSockets, `AudioContext`s or MediaPipe tasks must release them on unmount.

**Telemetry**

- Custom spans and metrics are named with the `zaru.` prefix (for example `zaru.hear.segment`, `zaru.vision.describe`, `zaru.caption.latency_ms`) and use the shared `tracer`/`meter` from `server/zaru/telemetry.py`.
- Each new pipeline stage (speech-to-text, speaker attribution, vision call, announcement) should get a span, so latency can be traced end to end in Dash0. Flag new stages without one as a non-blocking suggestion.
- Latency metrics are histograms in milliseconds with a `_ms` suffix.
- Attribute values follow the privacy instructions in `privacy.md` (no content, only sizes/timings/counts).
