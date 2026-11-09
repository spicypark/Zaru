import { useCallback, useEffect, useRef, useState } from "react";

export type MediaState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "live"; stream: MediaStream; mirrored: boolean }
  | { status: "error"; message: string };

export type StartResult = { ok: true; stream: MediaStream } | { ok: false; message: string };

// Rear camera on phones; laptops fall back to whatever webcam exists.
const VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

const AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Camera or microphone permission was denied.";
    if (err.name === "NotFoundError") return "No camera or microphone was found.";
    if (err.name === "NotReadableError") return "The camera is in use by another app.";
  }
  if (!window.isSecureContext) return "Camera access needs HTTPS.";
  return "Could not start the camera.";
}

/** Must be started from a user gesture (iOS requirement). Stops all tracks on unmount. */
export function useMediaStream(withAudio: boolean) {
  const [state, setState] = useState<MediaState>({ status: "idle" });
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async (): Promise<StartResult> => {
    setState({ status: "starting" });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: VIDEO,
        audio: withAudio ? AUDIO : false,
      });
      stop();
      streamRef.current = stream;
      // Front cameras and webcams report "user" or nothing; mirror those so it feels natural.
      const facing = stream.getVideoTracks()[0]?.getSettings().facingMode;
      setState({ status: "live", stream, mirrored: facing !== "environment" });
      return { ok: true, stream };
    } catch (err) {
      const message = describeError(err);
      setState({ status: "error", message });
      return { ok: false, message };
    }
  }, [withAudio, stop]);

  useEffect(() => stop, [stop]);

  return { state, start, stop };
}
