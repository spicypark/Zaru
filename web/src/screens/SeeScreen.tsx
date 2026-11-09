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
    const result = await start();
    speak(result.ok ? "Zaru See is ready." : result.message);
  };

  // No live regions in See mode: Zaru speaks every status itself, and an aria-live region would
  // make VoiceOver read the same text over speechSynthesis.

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
        {state.status === "error" && <p className="error">{state.message}</p>}
      </main>
    );
  }

  return (
    <main className="see live">
      <CameraView stream={state.stream} mirrored={state.mirrored} label="Camera view" />
      <p className="status">Zaru See is ready.</p>
      <button type="button" className="switch-mode" onClick={goToPicker}>
        Switch mode
      </button>
    </main>
  );
}
