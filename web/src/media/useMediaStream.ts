import { useCallback, useEffect, useRef, useState } from "react";
import { trackEvent, type CameraRestartReason } from "../telemetry";

export type Facing = "environment" | "user";

export type MediaState =
  | { status: "idle" }
  | { status: "starting" }
  | {
      status: "live";
      /** Camera (+ mic if requested), for display. Replaced when the camera flips or restarts. */
      stream: MediaStream;
      /** Mic only (empty without audio), stable across camera changes so audio doesn't restart. */
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

// How long a muted camera track may stay muted before we reopen it, and the retry schedule.
const MUTE_GRACE_MS = 2000;
const RESTART_DELAYS_MS = [0, 500, 1500, 3000];

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

/**
 * Calls `onDead` when the camera track ends, or stays muted for MUTE_GRACE_MS. iOS ends or mutes
 * the camera on interruptions (calls, Control Center, screen lock, backgrounding, another app
 * taking the camera, thermal limits). Returns a function that stops watching.
 */
function watchTrack(
  track: MediaStreamTrack,
  onDead: (reason: CameraRestartReason) => void,
): () => void {
  let muteTimer: number | undefined;
  const onEnded = () => onDead("ended");
  const onMute = () => {
    window.clearTimeout(muteTimer);
    muteTimer = window.setTimeout(() => track.muted && onDead("muted"), MUTE_GRACE_MS);
  };
  const onUnmute = () => window.clearTimeout(muteTimer);
  track.addEventListener("ended", onEnded);
  track.addEventListener("mute", onMute);
  track.addEventListener("unmute", onUnmute);
  return () => {
    window.clearTimeout(muteTimer);
    track.removeEventListener("ended", onEnded);
    track.removeEventListener("mute", onMute);
    track.removeEventListener("unmute", onUnmute);
  };
}

/**
 * Camera (and optionally mic) for a screen. Must be started from a user gesture (iOS requirement).
 * The camera is watched and reopened automatically if it dies; everything stops on unmount.
 */
export function useMediaStream(withAudio: boolean) {
  const [state, setState] = useState<MediaState>({ status: "idle" });
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const facingRef = useRef<Facing>("environment");
  const switchingRef = useRef(false);
  const unwatchRef = useRef<(() => void) | null>(null);
  // Camera requests can resolve after the screen has gone away; such tracks must be stopped
  // immediately rather than stored, or the camera light stays on.
  const mountedRef = useRef(true);
  // Set below; lets the track watcher call the latest restart function.
  const restartRef = useRef<(reason: CameraRestartReason) => void>(() => {});

  const stop = useCallback(() => {
    unwatchRef.current?.();
    unwatchRef.current = null;
    videoTrackRef.current?.stop();
    videoTrackRef.current = null;
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;
  }, []);

  /** Makes `track` the current camera, watches it, and publishes a new display stream. */
  const adopt = useCallback(async (track: MediaStreamTrack, audioStream: MediaStream) => {
    unwatchRef.current?.();
    videoTrackRef.current = track;
    unwatchRef.current = watchTrack(track, (reason) => restartRef.current(reason));
    const stream = new MediaStream([track, ...audioStream.getAudioTracks()]);
    const canFlip = (await countCameras()) > 1;
    if (mountedRef.current) {
      setState({ status: "live", stream, audioStream, mirrored: isMirrored(track), canFlip });
    }
    return stream;
  }, []);

  const releaseVideo = useCallback(() => {
    unwatchRef.current?.();
    unwatchRef.current = null;
    videoTrackRef.current?.stop();
    videoTrackRef.current = null;
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
      audioStreamRef.current = new MediaStream(media.getAudioTracks());
      const stream = await adopt(media.getVideoTracks()[0], audioStreamRef.current);
      return { ok: true, stream };
    } catch (err) {
      const message = describeError(err);
      setState({ status: "error", message });
      return { ok: false, message };
    }
  }, [withAudio, stop, adopt]);

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

  /** Reopen the current camera (same direction) after it froze, ended or was interrupted. */
  const restartVideo = useCallback(
    async (reason: CameraRestartReason) => {
      const audioStream = audioStreamRef.current;
      if (!audioStream || switchingRef.current || !mountedRef.current) return;
      switchingRef.current = true;
      const startedAt = performance.now();
      const report = (outcome: "ok" | "failed") =>
        trackEvent("zaru.camera.restart", {
          mode: withAudio ? "hear" : "see",
          reason,
          outcome,
          duration_ms: performance.now() - startedAt,
        });
      try {
        releaseVideo();
        let track: MediaStreamTrack | null = null;
        for (const delay of RESTART_DELAYS_MS) {
          await new Promise((r) => window.setTimeout(r, delay));
          if (!mountedRef.current) return;
          track = await openCamera(facingRef.current, false);
          if (track) break;
        }
        if (!mountedRef.current) return;
        if (!track) {
          report("failed");
          stop();
          setState({ status: "error", message: "The camera stopped. Tap to start again." });
          return;
        }
        await adopt(track, audioStream);
        report("ok");
      } finally {
        switchingRef.current = false;
      }
    },
    [withAudio, openCamera, adopt, releaseVideo, stop],
  );

  useEffect(() => {
    restartRef.current = (reason) => void restartVideo(reason);
  }, [restartVideo]);

  // Coming back to the app: if the camera died while hidden, reopen it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !audioStreamRef.current) return;
      const track = videoTrackRef.current;
      if (!track || track.readyState === "ended" || track.muted) void restartVideo("visible");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [restartVideo]);

  /** Switch between the front and back cameras, keeping the microphone running. */
  const flip = useCallback(async () => {
    const audioStream = audioStreamRef.current;
    if (!audioStream || switchingRef.current) return;
    switchingRef.current = true;
    const previous = facingRef.current;
    const next: Facing = previous === "environment" ? "user" : "environment";
    try {
      // Many phones can only open one camera at a time, so release the current one first.
      releaseVideo();
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
      await adopt(track, audioStream);
    } finally {
      switchingRef.current = false;
    }
  }, [openCamera, adopt, releaseVideo, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  return { state, start, stop, flip, restartVideo };
}
