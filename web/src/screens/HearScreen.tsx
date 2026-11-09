import { useEffect, useState } from "react";
import { createAudioContext } from "../audio/audioContext";
import { setAudioSession } from "../audio/audioSession";
import { useFaceTracks } from "../cv/useFaceTracks";
import { DebugOverlay } from "../hear/DebugOverlay";
import { SpeechBubbles } from "../hear/SpeechBubbles";
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

const DEBUG = new URLSearchParams(window.location.search).has("debug");
// Minimum mouth activity for a face to count as "talking right now" (for live words that
// stream in before a turn ends and is attributed).
const LIVE_SPEAKER_MIN_ACTIVITY = 0.01;

export function HearScreen() {
  const { state, start, flip } = useMediaStream(true);
  const [audioCtx, setAudioCtx] = useState<AudioContext | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const live = state.status === "live";
  // The mic-only stream survives camera flips, so captions keep running while switching.
  const audioStream = live ? state.audioStream : null;
  const { faces, stats: faceStats, tracksRef } = useFaceTracks(live ? video : null);
  const { captions, status, speaking, backend, turnSpeakers, audioDebugRef } = useHearSession(
    audioStream,
    audioCtx,
    tracksRef,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => void audioCtx?.close(), [audioCtx]);

  const onStart = () => {
    // Hear keeps the mic open the whole time. The AudioContext must be created inside the tap
    // for iOS to let it run.
    setAudioSession("play-and-record");
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

  const visible = captions.filter(
    (c) => now - c.updatedAt < (c.final ? CAPTION_TTL_MS : PARTIAL_TTL_MS),
  );
  const faceIds = new Set(faces.map((f) => f.id));
  const liveSpeaker = faces.reduce<(typeof faces)[number] | null>(
    (best, f) =>
      f.activity >= LIVE_SPEAKER_MIN_ACTIVITY && (!best || f.activity > best.activity) ? f : best,
    null,
  );
  // A caption goes in its speaker's bubble while that face is on screen; otherwise (no clear
  // speaker, or they left the frame) it goes to the caption bar so nothing is ever dropped.
  const bubbles: { caption: (typeof visible)[number]; faceId: number }[] = [];
  const barCaptions: typeof visible = [];
  for (const caption of visible) {
    // Finished turns use the face chosen when the turn ended; words still streaming in for an
    // open turn follow whoever's mouth is moving most right now.
    const decided = caption.turn !== null && turnSpeakers.has(caption.turn);
    const faceId = decided
      ? (turnSpeakers.get(caption.turn!) ?? null)
      : !caption.final
        ? (liveSpeaker?.id ?? null)
        : null;
    if (faceId !== null && faceIds.has(faceId)) bubbles.push({ caption, faceId });
    else barCaptions.push(caption);
  }
  const barShown = barCaptions.slice(-2);

  return (
    <main className="hear live">
      <CameraView
        stream={state.stream}
        mirrored={state.mirrored}
        label="Camera view"
        onVideo={setVideo}
      />
      {video && (
        <SpeechBubbles faces={faces} bubbles={bubbles} video={video} mirrored={state.mirrored} />
      )}
      {video && DEBUG && (
        <DebugOverlay
          faces={faces}
          video={video}
          mirrored={state.mirrored}
          audioRef={audioDebugRef}
          stats={faceStats}
        />
      )}
      <div className={speaking ? "hear-status speaking" : "hear-status"} aria-hidden="true">
        <span className="dot" />
        {status === "ready" && speaking ? "Hearing speech" : STATUS_TEXT[status]}
        {status === "ready" && backend === "local" && (
          <span className="backend-tag">Local captions</span>
        )}
      </div>
      {/* Every caption is announced here for screen-reader and braille users, including the
          ones shown in bubbles; only unattributed ones are drawn in the bar. */}
      <div className="visually-hidden" aria-live="polite">
        {visible.filter((c) => c.final).slice(-1).map((c) => (
          <p key={c.item}>{c.text}</p>
        ))}
      </div>
      {(barShown.length > 0 || bubbles.length === 0) && (
        <div className="caption-bar" aria-hidden="true">
          {barShown.length === 0 ? (
            <span className="caption-placeholder">
              {status === "ready" ? "Captions will appear here." : STATUS_TEXT[status]}
            </span>
          ) : (
            barShown.map((c) => (
              <p key={c.item} className={c.final ? "caption" : "caption partial"}>
                {c.text}
              </p>
            ))
          )}
        </div>
      )}
      <div className="top-actions">
        {state.canFlip && (
          <button type="button" className="pill-button" onClick={() => void flip()}>
            Flip camera
          </button>
        )}
        <button type="button" className="pill-button" onClick={goToPicker}>
          Switch mode
        </button>
      </div>
    </main>
  );
}
