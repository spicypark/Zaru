import { useEffect, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createFaceLandmarker, FaceTracker, type TrackedFace } from "./faceTracker";

// ~15 fps is plenty for mouth movement and keeps phones cool.
const FRAME_INTERVAL_MS = 66;

export type FaceTracksState = "loading" | "ready" | "unavailable";

/**
 * Runs MediaPipe face landmarks on the video and returns tracked faces. `tracksRef` always has
 * the latest faces (for the audio loop); `faces` is React state for rendering.
 */
export function useFaceTracks(video: HTMLVideoElement | null) {
  const [faces, setFaces] = useState<TrackedFace[]>([]);
  const [state, setState] = useState<FaceTracksState>("loading");
  const tracksRef = useRef<TrackedFace[]>([]);

  useEffect(() => {
    if (!video) return;
    let landmarker: FaceLandmarker | null = null;
    let frame = 0;
    let lastRun = 0;
    let lastVideoTime = -1;
    let stopped = false;
    const tracker = new FaceTracker();

    const loop = (now: number) => {
      if (stopped) return;
      frame = requestAnimationFrame(loop);
      if (!landmarker || now - lastRun < FRAME_INTERVAL_MS) return;
      if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
      lastRun = now;
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, now);
      const tracks = tracker.update(result, now);
      tracksRef.current = tracks;
      setFaces(tracks);
    };

    createFaceLandmarker()
      .then((created) => {
        if (stopped) {
          created.close();
          return;
        }
        landmarker = created;
        setState("ready");
        frame = requestAnimationFrame(loop);
      })
      .catch(() => setState("unavailable"));

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      landmarker?.close();
      tracksRef.current = [];
    };
  }, [video]);

  return { faces, state, tracksRef };
}
