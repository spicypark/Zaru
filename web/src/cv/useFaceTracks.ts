import { useEffect, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { trackEvent } from "../telemetry";
import { createFaceLandmarker, FaceTracker, type Delegate, type TrackedFace } from "./faceTracker";

// ~15 fps is plenty for mouth movement and keeps phones cool.
const FRAME_INTERVAL_MS = 66;
// After this many consecutive detection errors on GPU, rebuild the landmarker on CPU.
const MAX_GPU_ERRORS = 3;
// How often the health of the detector is reported to telemetry.
const REPORT_EVERY_S = 30;

export type FaceTracksState = "loading" | "ready" | "unavailable";

/** Live numbers for the debug overlay. */
export type FaceStats = { state: FaceTracksState; delegate: Delegate | null; fps: number; errors: number };

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/**
 * Runs MediaPipe face landmarks on the video and returns tracked faces. `tracksRef` always has
 * the latest faces (for the audio loop); `faces` is React state for rendering.
 */
export function useFaceTracks(video: HTMLVideoElement | null) {
  const [faces, setFaces] = useState<TrackedFace[]>([]);
  const [stats, setStats] = useState<FaceStats>({
    state: "loading",
    delegate: null,
    fps: 0,
    errors: 0,
  });
  const tracksRef = useRef<TrackedFace[]>([]);

  useEffect(() => {
    if (!video) return;
    const v = video as VideoWithFrameCallback;
    let landmarker: FaceLandmarker | null = null;
    let delegate: Delegate | null = null;
    let handle = 0;
    let usingVideoCallback = false;
    let lastRun = 0;
    let lastTimestamp = 0;
    let gpuErrors = 0;
    let errors = 0;
    let detections = 0;
    let reportDetections = 0;
    let reportErrors = 0;
    let reportSeconds = 0;
    let stopped = false;
    let rebuilding = false;
    const tracker = new FaceTracker();

    const schedule = () => {
      if (stopped) return;
      // Prefer one callback per decoded camera frame (Safari 15.4+, Chrome); otherwise rAF.
      if (v.requestVideoFrameCallback) {
        usingVideoCallback = true;
        handle = v.requestVideoFrameCallback(tick);
      } else {
        handle = requestAnimationFrame(tick);
      }
    };

    const load = (preferred?: Delegate) =>
      createFaceLandmarker(preferred)
        .then((created) => {
          if (stopped) {
            created.landmarker.close();
            return;
          }
          landmarker?.close();
          landmarker = created.landmarker;
          delegate = created.delegate;
          gpuErrors = 0;
          setStats((s) => ({ ...s, state: "ready", delegate }));
        })
        .catch(() => setStats((s) => ({ ...s, state: "unavailable" })));

    const tick = () => {
      if (stopped) return;
      schedule();
      const now = performance.now();
      if (!landmarker || rebuilding || now - lastRun < FRAME_INTERVAL_MS) return;
      if (v.readyState < 2 || !v.videoWidth) return;
      lastRun = now;
      // MediaPipe needs strictly increasing timestamps.
      lastTimestamp = Math.max(now, lastTimestamp + 1);
      try {
        const result = landmarker.detectForVideo(v, lastTimestamp);
        gpuErrors = 0;
        detections += 1;
        const tracks = tracker.update(result, now);
        tracksRef.current = tracks;
        setFaces(tracks);
      } catch {
        errors += 1;
        gpuErrors += 1;
        if (delegate === "GPU" && gpuErrors >= MAX_GPU_ERRORS && !rebuilding) {
          rebuilding = true;
          void load("CPU").finally(() => (rebuilding = false));
        }
      }
    };

    const statsTimer = window.setInterval(() => {
      setStats((s) => ({ ...s, fps: detections, errors }));
      reportDetections += detections;
      detections = 0;
      reportSeconds += 1;
      if (reportSeconds >= REPORT_EVERY_S) {
        if (delegate) {
          trackEvent("zaru.hear.face_detector", {
            delegate,
            fps: reportDetections / reportSeconds,
            errors: errors - reportErrors,
          });
        }
        reportDetections = 0;
        reportErrors = errors;
        reportSeconds = 0;
      }
    }, 1000);

    void load().then(schedule);

    return () => {
      stopped = true;
      window.clearInterval(statsTimer);
      if (usingVideoCallback) v.cancelVideoFrameCallback?.(handle);
      else cancelAnimationFrame(handle);
      landmarker?.close();
      tracksRef.current = [];
    };
  }, [video]);

  return { faces, stats, tracksRef };
}
