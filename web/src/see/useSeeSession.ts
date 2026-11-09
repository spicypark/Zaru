import { useCallback, useEffect, useRef, useState } from "react";
import type { ObjectDetector } from "@mediapipe/tasks-vision";
import { Earcons } from "../audio/earcons";
import { startMicCapture } from "../audio/micCapture";
import { pcmToWavBase64 } from "../audio/wav";
import { ApproachTracker, createPersonDetector } from "../cv/personDetector";
import { ask, describe, type SeeResult } from "./api";
import { captureJpeg, clockDirection, difference, thumbnail } from "./frames";
import { Speaker } from "./speech";

// --- Automatic announcements (the "only tell me what changed" loop) ---
const CHECK_INTERVAL_MS = 500;
// The view must differ from what was last described by this much (mean grey difference)...
const VIEW_CHANGE = 0.08;
// ...and have settled (little motion between checks) so the photo isn't blurred.
const SETTLED_MOTION = 0.025;
const SETTLED_CHECKS = 2;
// Ask anyway after this long, in case something changed that pixels don't show well.
const HEARTBEAT_MS = 25_000;
// Leave at least this long between automatic announcements (hazards excepted).
const AUTO_COOLDOWN_MS = 6_000;
const PERSON_INTERVAL_MS = 250;
const MAX_QUESTION_MS = 15_000;

export type SeeBusy = "idle" | "describing" | "listening" | "answering";

type Options = {
  video: HTMLVideoElement | null;
  audioStream: MediaStream | null;
  ctx: AudioContext | null;
  mirrored: boolean;
  speaker: Speaker;
};

/** Everything See mode does: on-demand Describe/Ask, plus automatic change announcements. */
export function useSeeSession({ video, audioStream, ctx, mirrored, speaker }: Options) {
  const [busy, setBusy] = useState<SeeBusy>("idle");
  const [log, setLog] = useState<string[]>([]);
  const busyRef = useRef<SeeBusy>("idle");
  const lastSummaryRef = useRef("");
  const earconsRef = useRef<Earcons | null>(null);
  const mountedRef = useRef(true);
  // Lets the 15 s auto-stop timer call the latest toggleAsk.
  const toggleAskRef = useRef<() => Promise<void>>(async () => {});
  const recordingRef = useRef<{ chunks: ArrayBuffer[]; stop: () => void; timer: number } | null>(
    null,
  );

  useEffect(() => {
    earconsRef.current = ctx ? new Earcons(ctx) : null;
  }, [ctx]);

  const setBusyState = (state: SeeBusy) => {
    busyRef.current = state;
    setBusy(state);
  };

  const announce = useCallback(
    (result: SeeResult, { urgent }: { urgent: boolean }) => {
      if (result.scene) lastSummaryRef.current = result.scene;
      if (!result.speak) return;
      if (result.priority === "hazard") earconsRef.current?.hazard();
      speaker.say(result.speak, { interrupt: urgent || result.priority === "hazard" });
      setLog((prev) => [...prev.slice(-19), result.speak]);
    },
    [speaker],
  );

  const explainError = useCallback(
    (err: unknown) => {
      const unconfigured = err instanceof Error && err.message === "unconfigured";
      speaker.say(
        unconfigured
          ? "Scene descriptions aren't set up on this server."
          : "Sorry, I couldn't reach the server. Try again.",
        { interrupt: true },
      );
    },
    [speaker],
  );

  /** "Describe what's around me". */
  const describeNow = useCallback(async () => {
    if (!video || busyRef.current === "listening") return;
    const image = captureJpeg(video);
    if (!image) return;
    speaker.stop();
    setBusyState("describing");
    const stopTicks = earconsRef.current?.thinking();
    try {
      announce(await describe(image, "describe"), { urgent: true });
    } catch (err) {
      explainError(err);
    } finally {
      stopTicks?.();
      setBusyState("idle");
    }
  }, [video, speaker, announce, explainError]);

  /** "Ask a question": first tap starts listening, second tap sends the question. */
  const toggleAsk = useCallback(async () => {
    if (!ctx || !audioStream || !video) return;
    const recording = recordingRef.current;
    if (!recording) {
      if (busyRef.current !== "idle") return;
      // Claim "listening" before awaiting the mic, so a second tap during startup is ignored
      // instead of opening a second capture.
      setBusyState("listening");
      speaker.stop();
      earconsRef.current?.recordStart();
      const chunks: ArrayBuffer[] = [];
      let stop: () => void;
      try {
        stop = await startMicCapture(ctx, audioStream, ({ pcm }) => chunks.push(pcm));
      } catch {
        if (mountedRef.current) {
          setBusyState("idle");
          speaker.say("I couldn't use the microphone.", { interrupt: true });
        }
        return;
      }
      if (!mountedRef.current) {
        stop();
        return;
      }
      const timer = window.setTimeout(() => void toggleAskRef.current(), MAX_QUESTION_MS);
      recordingRef.current = { chunks, stop, timer };
      return;
    }
    recordingRef.current = null;
    window.clearTimeout(recording.timer);
    recording.stop();
    earconsRef.current?.recordStop();
    const image = captureJpeg(video);
    if (!image || recording.chunks.length < 3) {
      setBusyState("idle");
      speaker.say("I didn't hear a question.", { interrupt: true });
      return;
    }
    setBusyState("answering");
    const stopTicks = earconsRef.current?.thinking();
    try {
      announce(await ask(image, pcmToWavBase64(recording.chunks)), { urgent: true });
    } catch (err) {
      explainError(err);
    } finally {
      stopTicks?.();
      setBusyState("idle");
    }
  }, [ctx, audioStream, video, speaker, announce, explainError]);

  useEffect(() => {
    toggleAskRef.current = toggleAsk;
  }, [toggleAsk]);

  const stopSpeaking = useCallback(() => speaker.stop(), [speaker]);

  // Automatic loop: notice view changes on-device, ask the model only then.
  useEffect(() => {
    if (!video) return;
    let stopped = false;
    let inFlight = false;
    let lastSent: Float32Array | null = null;
    let previous: Float32Array | null = null;
    let settled = 0;
    let lastCallAt = performance.now();
    let lastAnnouncedAt = 0;

    const check = async () => {
      const now = performance.now();
      const thumb = thumbnail(video);
      if (!thumb || stopped) return;
      const motion = previous ? difference(previous, thumb) : 1;
      previous = thumb;
      settled = motion < SETTLED_MOTION ? settled + 1 : 0;

      if (inFlight || busyRef.current !== "idle" || speaker.busy) return;
      if (now - lastAnnouncedAt < AUTO_COOLDOWN_MS) return;
      const changed = !lastSent || difference(lastSent, thumb) > VIEW_CHANGE;
      const heartbeat = now - lastCallAt > HEARTBEAT_MS;
      if (!(changed && settled >= SETTLED_CHECKS) && !heartbeat) return;

      const image = captureJpeg(video);
      if (!image) return;
      inFlight = true;
      lastCallAt = now;
      lastSent = thumb;
      try {
        const result = await describe(
          image,
          "auto",
          lastSummaryRef.current,
          changed ? "view_changed" : "heartbeat",
        );
        // Drop it if the user started their own request meanwhile.
        if (!stopped && busyRef.current === "idle") {
          announce(result, { urgent: false });
          if (result.speak) lastAnnouncedAt = performance.now();
        }
      } catch {
        // Automatic checks fail quietly; the buttons report errors.
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [video, speaker, announce]);

  // On-device person detector: instant "person approaching" without waiting on the model.
  useEffect(() => {
    if (!video) return;
    let detector: ObjectDetector | null = null;
    let stopped = false;
    let timestamp = 0;
    const tracker = new ApproachTracker();

    const timer = window.setInterval(() => {
      if (!detector || !video.videoWidth || busyRef.current === "listening") return;
      timestamp = Math.max(performance.now(), timestamp + 1);
      try {
        const result = detector.detectForVideo(video, timestamp);
        const boxes = result.detections.flatMap((d) =>
          d.boundingBox
            ? [
                {
                  x: d.boundingBox.originX / video.videoWidth,
                  y: d.boundingBox.originY / video.videoHeight,
                  w: d.boundingBox.width / video.videoWidth,
                  h: d.boundingBox.height / video.videoHeight,
                },
              ]
            : [],
        );
        for (const event of tracker.update(boxes, performance.now())) {
          if (busyRef.current !== "idle") continue;
          earconsRef.current?.hazard();
          speaker.say(`Person approaching, ${clockDirection(event.x, mirrored)}.`, {
            interrupt: true,
          });
        }
      } catch {
        // Skip this frame.
      }
    }, PERSON_INTERVAL_MS);

    createPersonDetector()
      .then((created) => {
        if (stopped) created.close();
        else detector = created;
      })
      .catch(() => {});

    return () => {
      stopped = true;
      window.clearInterval(timer);
      detector?.close();
    };
  }, [video, mirrored, speaker]);

  // Release the mic if the screen closes mid-question.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recording = recordingRef.current;
      if (recording) {
        window.clearTimeout(recording.timer);
        recording.stop();
        recordingRef.current = null;
      }
    };
  }, []);

  return { busy, log, describeNow, toggleAsk, stopSpeaking };
}
