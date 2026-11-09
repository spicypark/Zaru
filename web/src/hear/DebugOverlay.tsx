import { useEffect, useState, type RefObject } from "react";
import type { TrackedFace } from "../cv/faceTracker";
import { boxToScreen } from "../cv/videoMapping";
import type { AudioDebug } from "./useHearSession";

type Props = {
  faces: TrackedFace[];
  video: HTMLVideoElement;
  mirrored: boolean;
  audioRef: RefObject<AudioDebug>;
};

// Scale for drawing activity/level bars; values above this fill the bar.
const ACTIVITY_FULL = 0.08;
const LEVEL_FULL = 0.1;

/** Shown with ?debug=1: face boxes with ids and mouth-activity bars, plus mic level vs gate. */
export function DebugOverlay({ faces, video, mirrored, audioRef }: Props) {
  const [audio, setAudio] = useState<AudioDebug>({ rms: 0, threshold: 0 });

  // The mic level lives in a ref (updated on the audio thread's schedule); sample it for display.
  useEffect(() => {
    const timer = window.setInterval(() => setAudio({ ...audioRef.current }), 100);
    return () => window.clearInterval(timer);
  }, [audioRef]);

  return (
    <div className="debug" aria-hidden="true">
      {faces.map((face) => {
        const r = boxToScreen(face.box, video, mirrored);
        const fill = Math.min(1, face.activity / ACTIVITY_FULL);
        return (
          <div
            key={face.id}
            className="debug-face"
            style={{ left: r.left, top: r.top, width: r.width, height: r.height, borderColor: face.color }}
          >
            <span className="debug-label" style={{ background: face.color }}>
              #{face.id} {face.activity.toFixed(3)}
            </span>
            <span className="debug-bar" style={{ width: `${fill * 100}%`, background: face.color }} />
          </div>
        );
      })}
      <div className="debug-level">
        <span style={{ width: `${Math.min(1, audio.rms / LEVEL_FULL) * 100}%` }} />
        <i style={{ left: `${Math.min(1, audio.threshold / LEVEL_FULL) * 100}%` }} />
      </div>
    </div>
  );
}
