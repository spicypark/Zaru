import type { TrackedFace } from "../cv/faceTracker";
import { boxToScreen } from "../cv/videoMapping";
import type { Caption } from "./captions";

type Props = {
  faces: TrackedFace[];
  /** Visible captions already matched to a face id. */
  bubbles: { caption: Caption; faceId: number }[];
  video: HTMLVideoElement;
  mirrored: boolean;
};

const BUBBLE_MAX_WIDTH = 320;
const EDGE_MARGIN = 8;
const GAP_ABOVE_FACE = 12;

/** A speech bubble above each face that has recent captions; newest caption text only. */
export function SpeechBubbles({ faces, bubbles, video, mirrored }: Props) {
  const width = video.clientWidth;

  return (
    <div className="bubbles" aria-hidden="true">
      {faces.map((face) => {
        const mine = bubbles.filter((b) => b.faceId === face.id);
        if (mine.length === 0) return null;
        const latest = mine[mine.length - 1].caption;
        const rect = boxToScreen(face.box, video, mirrored);
        const bubbleWidth = Math.min(BUBBLE_MAX_WIDTH, width - EDGE_MARGIN * 2);
        const center = rect.left + rect.width / 2;
        const left = Math.min(
          Math.max(center - bubbleWidth / 2, EDGE_MARGIN),
          width - bubbleWidth - EDGE_MARGIN,
        );
        // Anchor the bubble's bottom just above the head; keep it on screen.
        const bottomFromTop = Math.max(rect.top - GAP_ABOVE_FACE, 96);
        const tailX = Math.min(Math.max(center - left, 24), bubbleWidth - 24);
        return (
          <div
            key={face.id}
            className={latest.final ? "bubble" : "bubble partial"}
            style={{
              left,
              top: bottomFromTop,
              width: bubbleWidth,
              borderColor: face.color,
              ["--tail-x" as string]: `${tailX}px`,
              ["--speaker" as string]: face.color,
            }}
          >
            {latest.text}
          </div>
        );
      })}
    </div>
  );
}
