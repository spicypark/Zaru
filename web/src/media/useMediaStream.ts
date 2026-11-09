import { useCallback, useEffect, useRef, useState } from "react";

export type Facing = "environment" | "user";

export type MediaState =
  | { status: "idle" }
  | { status: "starting" }
  | {
      status: "live";
      /** Camera + mic, for display. Replaced when the camera is flipped. */
      stream: MediaStream;
      /** Mic only, and stable across camera flips, so audio pipelines don't restart. */
      audioStream: MediaStream;
      mirrored: boolean;
      /** True when the device has more than one camera (front/back). */
      canFlip: boolean;
    }
  | { status: "error"; message: string };

export type StartResult = { ok: true; stream: MediaStream } | { ok: false; message: string };

// Rear camera on phones; laptops fall back to whatever webcam exists.
const videoConstraints = (facing: Facing, exact = false): MediaTrackConstraints => ({
  facingMode: exact ? { exact: facing } : { ideal: facing },
  width: { ideal: 1280 },
  height: { ideal: 720 },
});

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

// Front cameras and webcams report "user" or nothing; mirror those so it feels natural.
function isMirrored(track: MediaStreamTrack | undefined): boolean {
  return track?.getSettings().facingMode !== "environment";
}

async function countCameras(): Promise<number> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length;
  } catch {
    return 1;
  }
}

/** Must be started from a user gesture (iOS requirement). Stops all tracks on unmount. */
export function useMediaStream(withAudio: boolean) {
  const [state, setState] = useState<MediaState>({ status: "idle" });
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const facingRef = useRef<Facing>("environment");
  const flippingRef = useRef(false);

  const stop = useCallback(() => {
    videoTrackRef.current?.stop();
    videoTrackRef.current = null;
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;
  }, []);

  // Camera requests can resolve after the screen has gone away; such tracks must be stopped
  // immediately rather than stored, or the camera light stays on.
  const mountedRef = useRef(true);

  const publish = useCallback(async (video: MediaStreamTrack, audioStream: MediaStream) => {
    const stream = new MediaStream([video, ...audioStream.getAudioTracks()]);
    const canFlip = (await countCameras()) > 1;
    if (mountedRef.current) {
      setState({ status: "live", stream, audioStream, mirrored: isMirrored(video), canFlip });
    }
    return stream;
  }, []);

  const start = useCallback(async (): Promise<StartResult> => {
    setState({ status: "starting" });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
      const media = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(facingRef.current),
        audio: withAudio ? AUDIO : false,
      });
      if (!mountedRef.current) {
        media.getTracks().forEach((t) => t.stop());
        return { ok: false, message: "Closed." };
      }
      stop();
      const video = media.getVideoTracks()[0];
      videoTrackRef.current = video;
      audioStreamRef.current = new MediaStream(media.getAudioTracks());
      const stream = await publish(video, audioStreamRef.current);
      return { ok: true, stream };
    } catch (err) {
      const message = describeError(err);
      setState({ status: "error", message });
      return { ok: false, message };
    }
  }, [withAudio, stop, publish]);

  /** Opens one camera; null if it failed. Stops the track if the screen unmounted meanwhile. */
  const openCamera = useCallback(async (facing: Facing, exact: boolean) => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(facing, exact),
      });
      const track = media.getVideoTracks()[0];
      if (!mountedRef.current) {
        track.stop();
        return null;
      }
      return track;
    } catch {
      return null;
    }
  }, []);

  /** Switch between the front and back cameras, keeping the microphone running. */
  const flip = useCallback(async () => {
    const audioStream = audioStreamRef.current;
    if (!audioStream || flippingRef.current) return;
    flippingRef.current = true;
    const previous = facingRef.current;
    const next: Facing = previous === "environment" ? "user" : "environment";
    try {
      // Many phones can only open one camera at a time, so release the current one first.
      videoTrackRef.current?.stop();
      videoTrackRef.current = null;

      let track = await openCamera(next, true);
      if (track) {
        facingRef.current = next;
      } else {
        // Couldn't open the other camera; reopen the one we had.
        track = await openCamera(previous, false);
      }
      if (!mountedRef.current) return;
      if (!track) {
        // Neither camera opened: release the mic too and show an error with a fresh Start.
        stop();
        setState({ status: "error", message: "Could not switch cameras. Tap to start again." });
        return;
      }
      videoTrackRef.current = track;
      await publish(track, audioStream);
    } finally {
      flippingRef.current = false;
    }
  }, [openCamera, publish, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  return { state, start, stop, flip };
}
