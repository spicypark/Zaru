import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import { preferredDelegate, type Box, type Delegate } from "./faceTracker";

export async function createPersonDetector(
  delegate: Delegate = preferredDelegate(),
): Promise<ObjectDetector> {
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const options = (d: Delegate) => ({
    baseOptions: { modelAssetPath: "/mediapipe/efficientdet_lite0.tflite", delegate: d },
    runningMode: "VIDEO" as const,
    scoreThreshold: 0.5,
    categoryAllowlist: ["person"],
    maxResults: 5,
  });
  if (delegate === "GPU") {
    try {
      return await ObjectDetector.createFromOptions(fileset, options("GPU"));
    } catch {
      // fall through to CPU
    }
  }
  return ObjectDetector.createFromOptions(fileset, options("CPU"));
}

export type PersonEvent = { kind: "approaching"; x: number };

// A person counts as approaching when their box area grows this much within the window.
const GROWTH = 1.35;
const WINDOW_MS = 1200;
// Ignore far-away people (tiny boxes) and people already filling the frame.
const MIN_AREA = 0.03;
const MAX_AREA = 0.6;
const MIN_IOU = 0.2;

type Track = { box: Box; history: { t: number; area: number }[]; announcedAt: number };

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Tracks people across frames and reports someone walking towards the camera. */
export class ApproachTracker {
  private tracks: Track[] = [];
  count = 0;

  update(boxes: Box[], now: number): PersonEvent[] {
    const events: PersonEvent[] = [];
    const next: Track[] = [];
    for (const box of boxes) {
      const area = box.w * box.h;
      const match = this.tracks
        .filter((t) => !next.includes(t))
        .sort((a, b) => iou(b.box, box) - iou(a.box, box))[0];
      const track: Track =
        match && iou(match.box, box) >= MIN_IOU ? match : { box, history: [], announcedAt: 0 };
      track.box = box;
      track.history.push({ t: now, area });
      track.history = track.history.filter((h) => now - h.t <= WINDOW_MS);
      const oldest = track.history[0];
      const growing = oldest && area >= oldest.area * GROWTH && now - oldest.t >= 400;
      if (growing && area >= MIN_AREA && area <= MAX_AREA && now - track.announcedAt > 8000) {
        track.announcedAt = now;
        events.push({ kind: "approaching", x: box.x + box.w / 2 });
      }
      next.push(track);
    }
    this.tracks = next;
    this.count = boxes.length;
    return events;
  }
}
