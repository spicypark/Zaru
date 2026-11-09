import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAudioContext } from "../audio/audioContext";
import { CameraView } from "../media/CameraView";
import { useMediaStream } from "../media/useMediaStream";
import { keepScreenOn } from "../media/wakeLock";
import { goToPicker } from "../modes";
import { Speaker } from "../see/speech";
import { useNarration, type NarrationStatus } from "../see/useNarration";

const STATUS_LABEL: Record<NarrationStatus, string> = {
  listening: "Narrating",
  looking: "Looking…",
  stopped: "Paused",
};

export function SeeScreen() {
  // Camera only: See mode never opens the microphone. On iPhones an open mic switches audio to
  // call mode, which cuts off and reroutes Zaru's speech.
  const { state, start, restartVideo } = useMediaStream(false);
  const speaker = useMemo(() => new Speaker(), []);
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [running, setRunning] = useState(false);
  const [rate, setRate] = useState(speaker.rate);
  const [showSettings, setShowSettings] = useState(false);
  const live = state.status === "live";

  const onFrozen = useCallback(() => void restartVideo(), [restartVideo]);
  const { status, pulse } = useNarration({
    running: live && running,
    video: live ? video : null,
    ctx: audioCtx,
    mirrored: live && state.mirrored,
    speaker,
    onFrozen,
  });

  useEffect(() => () => void audioCtx?.close(), [audioCtx]);

  // Keep the screen awake while narrating: an auto-locked iPhone stops the camera.
  useEffect(() => (live && running ? keepScreenOn() : undefined), [live, running]);

  const toggle = useCallback(() => setRunning((on) => !on), []);

  // Confirm pause/resume out loud. This effect is declared after useNarration, so it runs after
  // the narration cleanup (which silences speech) instead of being cut off by it.
  const announcedRef = useRef(false);
  // The very first start already said "Starting Zaru See"; don't cut it off with "Narration on".
  const skipNextAnnounceRef = useRef(false);
  useEffect(() => {
    if (!announcedRef.current) {
      announcedRef.current = true;
      return;
    }
    if (skipNextAnnounceRef.current) {
      skipNextAnnounceRef.current = false;
      return;
    }
    speaker.say(running ? "Narration on." : "Paused.", { interrupt: true });
  }, [running, speaker]);

  // Laptop: Space toggles narration (unless a control has focus), Escape stops speaking.
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key === "Escape") speaker.stop();
      if (target?.closest("button, a, input, select, textarea")) return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, toggle, speaker]);

  const onStart = async () => {
    // Inside the tap: unlock speech and audio for the session (iOS requirement).
    speaker.say("Starting Zaru See.", { interrupt: true });
    setAudioCtx(createAudioContext());
    const result = await start();
    if (result.ok) {
      skipNextAnnounceRef.current = true;
      setRunning(true);
    } else {
      speaker.say(result.message, { interrupt: true });
    }
  };

  const onRate = (value: number) => {
    setRate(value);
    speaker.setRate(value);
  };

  // No live regions and no on-screen copy of what Zaru says: everything is spoken.
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
      {/* A coloured flash around the edge marks each new spoken update (for sighted helpers). */}
      {pulse && <div key={pulse.id} className={`see-flash priority-${pulse.priority}`} />}
      <div className={`see-status status-${status}`} aria-hidden="true">
        <span className="dot" />
        {STATUS_LABEL[status]}
      </div>
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
      <button
        type="button"
        className={running ? "see-toggle running" : "see-toggle"}
        onClick={toggle}
        aria-label={running ? "Pause narration" : "Start narration"}
      >
        {running ? "Pause" : "Start"}
      </button>
    </main>
  );
}
