import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";

/** Normalised (0..1) box in the camera frame's coordinates. */
export type Box = { x: number; y: number; w: number; h: number };

export type TrackedFace = {
  id: number;
  box: Box;
  /** Current mouth opening signal (jaw-open blendshape + lip gap). */
  mouth: number;
  /** How much the mouth has been moving recently (std-dev of the mouth signal). */
  activity: number;
  lastSeen: number;
  color: string;
};

// Activity is the std-dev of the mouth signal over at least ACTIVITY_WINDOW_MS *and* at least
// MIN_ACTIVITY_SAMPLES detections (up to MAX_ACTIVITY_WINDOW_MS). A pure time window breaks when
// detection runs slowly (iPhone CPU, Low Power Mode): it holds one sample and reads 0 forever.
const ACTIVITY_WINDOW_MS = 400;
const MIN_ACTIVITY_SAMPLES = 4;
const MAX_ACTIVITY_WINDOW_MS = 1500;
const TRACK_TTL_MS = 1000;
const MIN_IOU = 0.2;
const MAX_CENTER_JUMP = 0.15;
const COLORS = ["#4cc9f0", "#ffb703", "#f72585", "#80ed99", "#c77dff", "#ff8fab"];

// Face mesh landmark indices: inner upper/lower lip, forehead top, chin.
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const FOREHEAD = 10;
const CHIN = 152;

export type Delegate = "GPU" | "CPU";

/** MediaPipe's WebGL (GPU) path is unreliable in iOS/iPadOS WebKit; use CPU there. */
export function preferredDelegate(): Delegate {
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return iOS ? "CPU" : "GPU";
}

export async function createFaceLandmarker(
  delegate: Delegate = preferredDelegate(),
): Promise<{ landmarker: FaceLandmarker; delegate: Delegate }> {
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const options = (delegate: Delegate) => ({
    baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
    runningMode: "VIDEO" as const,
    numFaces: 4,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  if (delegate === "GPU") {
    try {
      return { landmarker: await FaceLandmarker.createFromOptions(fileset, options("GPU")), delegate };
    } catch {
      // fall through to CPU
    }
  }
  return { landmarker: await FaceLandmarker.createFromOptions(fileset, options("CPU")), delegate: "CPU" };
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function centerDistance(a: Box, b: Box): number {
  return Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
}

type Detection = { box: Box; mouth: number };

function toDetections(result: FaceLandmarkerResult): Detection[] {
  return result.faceLandmarks.map((points, i) => {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const faceHeight = Math.max(1e-3, Math.abs(points[CHIN].y - points[FOREHEAD].y));
    const lipGap = Math.abs(points[LOWER_LIP].y - points[UPPER_LIP].y) / faceHeight;
    const jawOpen =
      result.faceBlendshapes?.[i]?.categories.find((c) => c.categoryName === "jawOpen")?.score ?? 0;
    return {
      box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      mouth: jawOpen + lipGap * 3,
    };
  });
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

/** Keeps stable IDs for faces across frames and measures each face's mouth movement. */
export class FaceTracker {
  private tracks = new Map<number, TrackedFace & { history: { t: number; v: number }[] }>();
  private nextId = 1;

  update(result: FaceLandmarkerResult, now: number): TrackedFace[] {
    const detections = toDetections(result);
    const unmatched = new Set(this.tracks.keys());

    for (const det of detections) {
      let bestId: number | null = null;
      let bestScore = 0;
      for (const id of unmatched) {
        const track = this.tracks.get(id)!;
        const overlap = iou(track.box, det.box);
        const near = centerDistance(track.box, det.box) < MAX_CENTER_JUMP;
        const score = overlap >= MIN_IOU ? overlap : near ? 0.01 : 0;
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }

      if (bestId === null) {
        const id = this.nextId++;
        this.tracks.set(id, {
          id,
          box: det.box,
          mouth: det.mouth,
          activity: 0,
          lastSeen: now,
          color: COLORS[(id - 1) % COLORS.length],
          history: [{ t: now, v: det.mouth }],
        });
        continue;
      }

      unmatched.delete(bestId);
      const track = this.tracks.get(bestId)!;
      track.box = det.box;
      track.mouth = det.mouth;
      track.lastSeen = now;
      track.history.push({ t: now, v: det.mouth });
      while (
        track.history.length > MIN_ACTIVITY_SAMPLES &&
        now - track.history[1].t >= ACTIVITY_WINDOW_MS
      ) {
        track.history.shift();
      }
      while (track.history.length && now - track.history[0].t > MAX_ACTIVITY_WINDOW_MS) {
        track.history.shift();
      }
      track.activity = stdDev(track.history.map((h) => h.v));
    }

    for (const id of unmatched) {
      const track = this.tracks.get(id)!;
      track.activity = 0;
      if (now - track.lastSeen > TRACK_TTL_MS) this.tracks.delete(id);
    }

    return this.snapshot();
  }

  snapshot(): TrackedFace[] {
    return [...this.tracks.values()].map((t) => ({
      id: t.id,
      box: t.box,
      mouth: t.mouth,
      activity: t.activity,
      lastSeen: t.lastSeen,
      color: t.color,
    }));
  }
}
