import { useEffect, useMemo, useState } from "react";
import { createAudioContext } from "../audio/audioContext";
import { CameraView } from "../media/CameraView";
import { useMediaStream } from "../media/useMediaStream";
import { goToPicker } from "../modes";
import { AnnouncementCard } from "../see/AnnouncementCard";
import { Speaker } from "../see/speech";
import { useSeeSession, type SeeBusy } from "../see/useSeeSession";

const ASK_LABEL: Record<SeeBusy, string> = {
  idle: "Ask a question",
  describing: "Ask a question",
  listening: "Listening… tap to send",
  answering: "Thinking…",
};

export function SeeScreen() {
  const { state, start } = useMediaStream(true);
  const speaker = useMemo(() => new Speaker(), []);
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [rate, setRate] = useState(speaker.rate);
  const [showSettings, setShowSettings] = useState(false);
  const live = state.status === "live";

  const { busy, log, describeNow, toggleAsk, stopSpeaking } = useSeeSession({
    video: live ? video : null,
    audioStream: live ? state.audioStream : null,
    ctx: audioCtx,
    mirrored: live && state.mirrored,
    speaker,
  });

  useEffect(() => () => void audioCtx?.close(), [audioCtx]);

  const latest = log.length > 0 ? log[log.length - 1] : null;
  const latestPriority = latest?.source === "approach" ? "approach" : latest?.priority;

  // Laptop shortcuts: Space = describe, Enter = ask (start/stop), Escape = stop speaking.
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      // Let focused buttons, links and inputs handle their own Enter/Space activation.
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, a, input, select, textarea")) {
        if (e.key === "Escape") stopSpeaking();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        void describeNow();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void toggleAsk();
      } else if (e.key === "Escape") {
        stopSpeaking();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, describeNow, toggleAsk, stopSpeaking]);

  const onStart = async () => {
    // Inside the tap: unlock speech and audio for the session (iOS requirement).
    speaker.say("Starting Zaru See.", { interrupt: true });
    setAudioCtx(createAudioContext());
    const result = await start();
    speaker.say(
      result.ok
        ? "Zaru See is ready. Top half: describe what's around me. Bottom half: ask a question."
        : result.message,
      { interrupt: true },
    );
  };

  const onRate = (value: number) => {
    setRate(value);
    speaker.setRate(value);
  };

  // No live regions in See mode: Zaru speaks every status itself, and an aria-live region would
  // make VoiceOver read the same text over speechSynthesis.
  if (!live) {
    return (
      <main className="see">
        <button
          type="button"
          className="start-button see"
          onClick={() => void onStart()}
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
      <CameraView
        stream={state.stream}
        mirrored={state.mirrored}
        label="Camera view"
        onVideo={setVideo}
      />
      {/* Flash around the screen edge whenever something new is announced. */}
      {latest && <div key={latest.id} className={`see-flash priority-${latestPriority}`} />}
      <div className="see-controls">
        {/* Top half: see-through, so the live camera stays visible. Tap the picture to describe. */}
        <button
          type="button"
          className="see-action describe"
          onClick={() => void describeNow()}
          disabled={busy === "listening"}
          aria-label="Describe what's around me"
        >
          <span className="see-action-label">
            {busy === "describing" ? "Looking…" : "Describe what's around me"}
          </span>
        </button>
        <button
          type="button"
          className={busy === "listening" ? "see-action ask listening" : "see-action ask"}
          onClick={() => void toggleAsk()}
          disabled={busy === "describing" || busy === "answering"}
          aria-label={busy === "listening" ? "Stop and send question" : "Ask a question"}
        >
          {ASK_LABEL[busy]}
        </button>
      </div>
      {latest && <AnnouncementCard key={latest.id} entry={latest} />}
      <div className="top-actions">
        <button
          type="button"
          className="pill-button"
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
        >
          Settings
        </button>
        <button type="button" className="pill-button" onClick={goToPicker}>
          Switch mode
        </button>
      </div>
      {showSettings && (
        <div className="see-settings">
          <label htmlFor="speech-rate">Speech rate {rate.toFixed(1)}×</label>
          <input
            id="speech-rate"
            type="range"
            min={0.6}
            max={1.8}
            step={0.1}
            value={rate}
            onChange={(e) => onRate(Number(e.target.value))}
            onPointerUp={() => speaker.say("This is the new speech rate.", { interrupt: true })}
          />
        </div>
      )}
    </main>
  );
}
