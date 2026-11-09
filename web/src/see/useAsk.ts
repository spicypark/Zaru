import { useCallback, useEffect, useRef, useState } from "react";
import { Earcons } from "../audio/earcons";
import { startMicCapture } from "../audio/micCapture";
import { pcmToWavBase64 } from "../audio/wav";
import { ask } from "./api";
import { captureJpeg } from "./frames";
import type { Speaker } from "./speech";

export type AskState = "idle" | "starting" | "listening" | "answering";

// Longest question; recording stops and sends by itself after this.
const MAX_QUESTION_MS = 15000;
// Fewer 100 ms frames than this means no real question was recorded.
const MIN_FRAMES = 4;

type Options = {
  video: HTMLVideoElement | null;
  ctx: AudioContext | null;
  speaker: Speaker;
};

/**
 * "Ask a question" for See mode: first tap starts listening, second tap sends the question with
 * the current frame, and the answer is spoken.
 *
 * The microphone is opened only while asking and released straight after. Keeping it open would
 * put iOS audio into call mode, which cuts off and reroutes Zaru's speech. `holdRef` is true
 * from the first tap until the answer is spoken, so narration doesn't talk over it.
 */
export function useAsk({ video, ctx, speaker }: Options) {
  const [state, setState] = useState<AskState>("idle");
  const stateRef = useRef<AskState>("idle");
  const holdRef = useRef(false);
  const mountedRef = useRef(true);
  const toggleRef = useRef<() => Promise<void>>(async () => {});
  const recordingRef = useRef<{
    chunks: ArrayBuffer[];
    stopCapture: () => void;
    mic: MediaStream;
    timer: number;
  } | null>(null);

  const set = (next: AskState) => {
    stateRef.current = next;
    holdRef.current = next !== "idle";
    if (mountedRef.current) setState(next);
  };

  const release = () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (!recording) return null;
    window.clearTimeout(recording.timer);
    recording.stopCapture();
    recording.mic.getTracks().forEach((t) => t.stop());
    return recording;
  };

  const toggle = useCallback(async () => {
    if (!ctx || !video) return;
    const earcons = new Earcons(ctx);

    if (stateRef.current === "idle") {
      set("starting");
      speaker.stop();
      let mic: MediaStream | null = null;
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!mountedRef.current) {
          mic.getTracks().forEach((t) => t.stop());
          return;
        }
        const chunks: ArrayBuffer[] = [];
        const stopCapture = await startMicCapture(ctx, mic, ({ pcm }) => chunks.push(pcm));
        const timer = window.setTimeout(() => void toggleRef.current(), MAX_QUESTION_MS);
        recordingRef.current = { chunks, stopCapture, mic, timer };
        earcons.recordStart();
        set("listening");
      } catch {
        mic?.getTracks().forEach((t) => t.stop());
        set("idle");
        speaker.say("I couldn't use the microphone.", { interrupt: true });
      }
      return;
    }

    if (stateRef.current !== "listening") return;
    const recording = release();
    earcons.recordStop();
    const image = captureJpeg(video);
    if (!recording || !image || recording.chunks.length < MIN_FRAMES) {
      set("idle");
      speaker.say("I didn't hear a question.", { interrupt: true });
      return;
    }
    set("answering");
    const stopTicks = earcons.thinking();
    try {
      const result = await ask(image, pcmToWavBase64(recording.chunks));
      if (!mountedRef.current) return;
      speaker.say(result.speak || "I couldn't answer that.", { interrupt: true });
    } catch (err) {
      const unconfigured = err instanceof Error && err.message === "unconfigured";
      speaker.say(
        unconfigured
          ? "Questions aren't set up on this server."
          : "Sorry, I couldn't reach the server. Try again.",
        { interrupt: true },
      );
    } finally {
      stopTicks();
      set("idle");
    }
  }, [ctx, video, speaker]);

  useEffect(() => {
    toggleRef.current = toggle;
  }, [toggle]);

  // Release the mic if the screen closes mid-question.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recording = recordingRef.current;
      recordingRef.current = null;
      if (recording) {
        window.clearTimeout(recording.timer);
        recording.stopCapture();
        recording.mic.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return { state, toggle, holdRef };
}
