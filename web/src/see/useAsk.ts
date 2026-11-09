import { useCallback, useEffect, useRef, useState } from "react";
import { Earcons } from "../audio/earcons";
import { setAudioSession } from "../audio/audioSession";
import { startMicCapture } from "../audio/micCapture";
import { pcmToWavBase64 } from "../audio/wav";
import { ask } from "./api";
import { captureJpeg } from "./frames";
import type { Speaker } from "./speech";

export type AskState = "idle" | "starting" | "listening" | "answering";

// Longest question; recording stops and sends by itself after this.
const MAX_QUESTION_MS = 15000;
// After the mic is released, iOS re-routes audio from call mode back to the loudspeaker; speech
// started during that switch gets cut off, so wait at least this long before answering.
const SETTLE_AFTER_MIC_MS = 700;
// Fewer 100 ms frames than this means no real question was recorded.
const MIN_FRAMES = 4;

// Longest an answer is waited on before narration resumes regardless.
const MAX_ANSWER_MS = 20000;

/** Resolves once the speaker has nothing playing or waiting (or after MAX_ANSWER_MS). */
function waitForSilence(speaker: Speaker): Promise<void> {
  const started = performance.now();
  return new Promise((resolve) => {
    const timer = window.setInterval(() => {
      if (!speaker.busy || performance.now() - started > MAX_ANSWER_MS) {
        window.clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

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

  const releasedAtRef = useRef(0);

  /** Back to iOS's default audio once the mic is closed (see audioSession.ts). */
  const backToPlayback = () => {
    setAudioSession("auto");
    releasedAtRef.current = performance.now();
  };

  const release = () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (!recording) return null;
    window.clearTimeout(recording.timer);
    recording.stopCapture();
    recording.mic.getTracks().forEach((t) => t.stop());
    backToPlayback();
    return recording;
  };

  /** Resolves once the audio route has had time to settle after the mic closed. */
  const settled = () =>
    new Promise<void>((resolve) =>
      window.setTimeout(
        resolve,
        Math.max(0, releasedAtRef.current + SETTLE_AFTER_MIC_MS - performance.now()),
      ),
    );

  const toggle = useCallback(async () => {
    if (!ctx || !video) return;
    const earcons = new Earcons(ctx);

    if (stateRef.current === "idle") {
      set("starting");
      speaker.stop();
      let mic: MediaStream | null = null;
      // Recording needs iOS "play-and-record"; release() switches back to playback.
      setAudioSession("play-and-record");
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!mountedRef.current) {
          mic.getTracks().forEach((t) => t.stop());
          backToPlayback();
          return;
        }
        const chunks: ArrayBuffer[] = [];
        const stopCapture = await startMicCapture(ctx, mic, ({ pcm }) => chunks.push(pcm));
        if (!mountedRef.current) {
          stopCapture();
          mic.getTracks().forEach((t) => t.stop());
          backToPlayback();
          return;
        }
        const timer = window.setTimeout(() => void toggleRef.current(), MAX_QUESTION_MS);
        recordingRef.current = { chunks, stopCapture, mic, timer };
        earcons.recordStart();
        set("listening");
      } catch {
        mic?.getTracks().forEach((t) => t.stop());
        backToPlayback();
        // Stay busy (button disabled, narration held) through the settle, then speak, then idle.
        set("answering");
        await settled();
        if (mountedRef.current) speaker.say("I couldn't use the microphone.", { interrupt: true });
        set("idle");
        // Keep narration held until the line has finished, like the answer path.
        holdRef.current = true;
        await waitForSilence(speaker);
        if ((stateRef.current as AskState) === "idle") holdRef.current = false;
      }
      return;
    }

    if (stateRef.current !== "listening") return;
    const recording = release();
    earcons.recordStop();
    const image = captureJpeg(video);
    if (!recording || !image || recording.chunks.length < MIN_FRAMES) {
      set("answering");
      await settled();
      if (mountedRef.current) speaker.say("I didn't hear a question.", { interrupt: true });
      set("idle");
      // Keep narration held until the line has finished, like the answer path.
      holdRef.current = true;
      await waitForSilence(speaker);
      if ((stateRef.current as AskState) === "idle") holdRef.current = false;
      return;
    }
    set("answering");
    const stopTicks = earcons.thinking();
    try {
      const result = await ask(image, pcmToWavBase64(recording.chunks));
      if (!mountedRef.current) return;
      stopTicks();
      await settled();
      speaker.say(result.speak || "I couldn't answer that.", { interrupt: true });
    } catch (err) {
      stopTicks();
      await settled();
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
      // set("idle") released the hold; keep it until the answer has finished playing.
      holdRef.current = true;
      await waitForSilence(speaker);
      if ((stateRef.current as AskState) === "idle") holdRef.current = false;
    }
    // release/settled/set only read and write refs, so they don't need to be dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setAudioSession("auto");
      }
    };
  }, []);

  return { state, toggle, holdRef };
}
