# Privacy: no stored or exported media, transcripts or prompts

Zaru processes live camera frames and microphone audio of people at conferences, many of whom never agreed to be recorded. Apply this check alongside the standard review to everything under `server/zaru/` and `web/src/`.

Flag as a **blocking** finding any change that:

- Writes audio, video frames, images or transcript text to disk, a database, a cache or object storage.
- Logs transcript text, user questions, model prompts that contain user speech, or image/audio bytes (any `logging`, `print`, `console.log` or OpenTelemetry log record).
- Adds transcript text, prompt text, image bytes or base64 payloads as OpenTelemetry span attributes, span events, metric attributes or baggage. Only lengths, durations, counts, model names, token counts and status codes are allowed.
- Enables OpenLIT message content capture (`capture_message_content=True`) or Dash0 Web SDK session recording or profiling (`@dash0/session-recording`, `@dash0/profiling`).
- Sends media or transcripts to any third party other than the OpenAI API.

Do not suppress standard reliability, security or maintainability findings because of this instruction.
