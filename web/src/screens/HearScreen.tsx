import { CameraView } from "../media/CameraView";
import { useMediaStream } from "../media/useMediaStream";
import { goToPicker } from "../modes";

export function HearScreen() {
  const { state, start } = useMediaStream(true);

  if (state.status !== "live") {
    return (
      <main className="hear">
        <button
          type="button"
          className="start-button hear"
          onClick={() => void start()}
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

  return (
    <main className="hear live">
      <CameraView stream={state.stream} mirrored={state.mirrored} label="Camera view" />
      <div className="caption-bar" aria-live="polite">
        Listening…
      </div>
      <button type="button" className="switch-mode" onClick={goToPicker}>
        Switch mode
      </button>
    </main>
  );
}
