import { useEffect, useState } from "react";
import { createAudioContext } from "../audio/audioContext";
import { useHearSession, type HearStatus } from "../hear/useHearSession";
import { CameraView } from "../media/CameraView";
import { useMediaStream } from "../media/useMediaStream";
import { goToPicker } from "../modes";

const STATUS_TEXT: Record<HearStatus, string> = {
  connecting: "Connecting…",
  ready: "Listening…",
  reconnecting: "Reconnecting…",
  unavailable: "Captions are unavailable right now.",
  "mic-error": "Could not read the microphone.",
};

// Captions stay on screen for a while after the speaker stops.
const CAPTION_TTL_MS = 8000;
// Partials that never get a final (dropped connection, upstream error) expire too.
const PARTIAL_TTL_MS = 15000;

export function HearScreen() {
  const { state, start } = useMediaStream(true);
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const stream = state.status === "live" ? state.stream : null;
  const { captions, status, speaking, backend } = useHearSession(stream, audioCtx);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => void audioCtx?.close(), [audioCtx]);

  const onStart = () => {
    // The AudioContext must be created inside the tap for iOS to let it run.
    setAudioCtx(createAudioContext());
    void start();
  };

  if (state.status !== "live") {
    return (
      <main className="hear">
        <button
          type="button"
          className="start-button hear"
          onClick={onStart}
          disabled={state.status === "starting"}
        >
          {state.status === "starting" ? "Starting…" : "Start Zaru Hear"}
          <span className="start-hint">Point your camera at the people talking</span>
        </button>
        {state.status === "error" && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
      </main>
    );
  }

  const visible = captions
    .filter((c) => now - c.updatedAt < (c.final ? CAPTION_TTL_MS : PARTIAL_TTL_MS))
    .slice(-2);

  return (
    <main className="hear live">
      <CameraView stream={state.stream} mirrored={state.mirrored} label="Camera view" />
      <div className={speaking ? "hear-status speaking" : "hear-status"} aria-hidden="true">
        <span className="dot" />
        {status === "ready" && speaking ? "Hearing speech" : STATUS_TEXT[status]}
        {status === "ready" && backend === "local" && (
          <span className="backend-tag">Local captions</span>
        )}
      </div>
      <div className="caption-bar" aria-live="polite">
        {visible.length === 0 ? (
          <span className="caption-placeholder">
            {status === "ready" ? "Captions will appear here." : STATUS_TEXT[status]}
          </span>
        ) : (
          visible.map((c) => (
            <p key={c.item} className={c.final ? "caption" : "caption partial"}>
              {c.text}
            </p>
          ))
        )}
      </div>
      <button type="button" className="switch-mode" onClick={goToPicker}>
        Switch mode
      </button>
    </main>
  );
}
