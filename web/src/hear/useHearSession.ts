import { useEffect, useReducer, useState } from "react";
import { startMicCapture } from "../audio/micCapture";
import { captionsReducer } from "./captions";
import { HearSocket, type SocketStatus } from "./hearSocket";
import { SpeechGate } from "./speechGate";

// Audio from just before speech is detected, so first syllables aren't clipped.
const PREROLL_FRAMES = 3;

export type HearStatus = SocketStatus | "mic-error";

/**
 * Streams the microphone to /ws/hear while someone is speaking and collects captions.
 * Only voiced audio (plus pre-roll and the trailing pause) is sent, which keeps transcription
 * cost down and avoids the model inventing words from room noise.
 */
export function useHearSession(stream: MediaStream | null, ctx: AudioContext | null) {
  const [captions, dispatch] = useReducer(captionsReducer, []);
  const [status, setStatus] = useState<HearStatus>("connecting");
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!stream || !ctx) return;
    let stopMic: (() => void) | null = null;
    let cancelled = false;

    const socket = new HearSocket(dispatch, setStatus);
    const gate = new SpeechGate();
    const preroll: ArrayBuffer[] = [];

    startMicCapture(ctx, stream, ({ pcm, rms }) => {
      const event = gate.update(rms, performance.now());
      if (event === "start") {
        setSpeaking(true);
        socket.sendControl("speech_start");
        preroll.splice(0).forEach((frame) => socket.sendAudio(frame));
      }
      if (gate.isSpeaking || event === "commit") {
        socket.sendAudio(pcm);
      } else {
        preroll.push(pcm);
        if (preroll.length > PREROLL_FRAMES) preroll.shift();
      }
      if (event === "commit") {
        socket.sendControl("commit");
        if (!gate.isSpeaking) setSpeaking(false);
      }
    })
      .then((stop) => {
        if (cancelled) stop();
        else stopMic = stop;
      })
      .catch(() => setStatus("mic-error"));

    return () => {
      cancelled = true;
      stopMic?.();
      socket.close();
    };
  }, [stream, ctx]);

  return { captions, status, speaking };
}
