import { CameraView } from "../media/CameraView";
import { useMediaStream } from "../media/useMediaStream";
import { goToPicker } from "../modes";

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

export function SeeScreen() {
  const { state, start } = useMediaStream(true);

  const onStart = async () => {
    // Speaking inside the tap unlocks speech synthesis on iOS for the rest of the session.
    speak("Starting Zaru See.");
    const stream = await start();
    speak(stream ? "Zaru See is ready." : "Zaru could not start the camera.");
  };

  if (state.status !== "live") {
    return (
      <main className="see">
        <button
          type="button"
          className="start-button see"
          onClick={onStart}
          disabled={state.status === "starting"}
        >
          {state.status === "starting" ? "Starting…" : "Start Zaru See"}
          <span className="start-hint">Double-tap or tap anywhere to begin</span>
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
    <main className="see live">
      <CameraView stream={state.stream} mirrored={state.mirrored} label="Camera view" />
      <p className="status" role="status">
        Zaru See is ready.
      </p>
      <button type="button" className="switch-mode" onClick={goToPicker}>
        Switch mode
      </button>
    </main>
  );
}
