import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import { startMicCapture } from "../audio/micCapture";
import type { TrackedFace } from "../cv/faceTracker";
import { trackEvent } from "../telemetry";
import { captionsReducer } from "./captions";
import { HearSocket, type CaptionBackend, type SocketStatus } from "./hearSocket";
import { TurnAttributor } from "./speakerAttribution";
import { SpeechGate } from "./speechGate";

// Audio from just before speech is detected, so first syllables aren't clipped.
const PREROLL_FRAMES = 3;
const OPENAI_MAX_TURN_MS = 5000;
const LOCAL_MAX_TURN_MS = 7000;
// Turns that never get a caption (noise, empty transcripts) are forgotten beyond this many.
const MAX_PENDING_TURNS = 20;

type Attribution = "face" | "caption_bar";
/** Bookkeeping for the on-screen caption latency event. Holds turn numbers and times only. */
type CaptionTiming = {
  /** Committed turns still waiting for their first caption. */
  pending: Map<number, { at: number; attribution: Attribution }>;
  /** Open turns whose streamed words are already on screen. */
  captioned: Set<number>;
  /** Caption items already accounted for. */
  items: Set<string>;
};

export type HearStatus = SocketStatus | "mic-error";

/** Live audio levels for the debug overlay. */
export type AudioDebug = {
  rms: number;
  threshold: number;
  /** Last turn: who won (face id or null) and every face's credit. */
  lastTurn: { turn: number; speaker: number | null; credits: [number, number][] } | null;
};

/**
 * Streams the microphone to /ws/hear while someone is speaking, collects captions, and decides
 * which tracked face spoke each turn (from mouth movement while the speech gate is open).
 * Only voiced audio (plus pre-roll and the trailing pause) is sent, which keeps transcription
 * cost down and avoids the model inventing words from room noise.
 */
export function useHearSession(
  stream: MediaStream | null,
  ctx: AudioContext | null,
  facesRef: RefObject<TrackedFace[]>,
) {
  const [captions, dispatch] = useReducer(captionsReducer, []);
  const [status, setStatus] = useState<HearStatus>("connecting");
  const [speaking, setSpeaking] = useState(false);
  // Kept apart from socket status so a later "ready"/"reconnecting" can't hide it.
  const [micError, setMicError] = useState(false);
  // Which transcription engine the server picked: OpenAI, or the local fallback model.
  const [backend, setBackend] = useState<CaptionBackend | null>(null);
  // Turn number -> face id that spoke it (null = no clear speaker, use the caption bar).
  const [turnSpeakers, setTurnSpeakers] = useState<ReadonlyMap<number, number | null>>(
    () => new Map(),
  );
  const audioDebugRef = useRef<AudioDebug>({ rms: 0, threshold: 0, lastTurn: null });
  const timingRef = useRef<CaptionTiming>({
    pending: new Map(),
    captioned: new Set(),
    items: new Set(),
  });

  // Runs after captions are committed to the screen: the first caption of a finished turn
  // closes the on-screen latency measurement for that turn.
  useEffect(() => {
    const timing = timingRef.current;
    for (const caption of captions) {
      if (caption.turn === null || timing.items.has(caption.item)) continue;
      const waiting = timing.pending.get(caption.turn);
      if (waiting) {
        timing.pending.delete(caption.turn);
        trackEvent("zaru.hear.caption", {
          latency_ms: performance.now() - waiting.at,
          before_commit: false,
          backend: backend ?? "unknown",
          attribution: waiting.attribution,
        });
      } else {
        timing.captioned.add(caption.turn);
      }
    }
    timing.items = new Set(captions.map((c) => c.item));
  }, [captions, backend]);

  useEffect(() => {
    if (!stream || !ctx) return;
    let stopMic: (() => void) | null = null;
    let cancelled = false;
    let turn = 0;
    let sessionBackend: CaptionBackend | null = null;
    // Turn numbers restart with each session.
    const timing = timingRef.current;
    timing.pending.clear();
    timing.captioned.clear();

    const gate = new SpeechGate();
    const attributor = new TurnAttributor();
    const socket = new HearSocket((msg) => {
      if (msg.type === "ready") {
        sessionBackend = msg.backend ?? null;
        setBackend(sessionBackend);
        // Whisper does much worse on sentence fragments, so let local turns run longer before
        // a forced commit. OpenAI keeps short turns for faster captions.
        gate.maxTurnMs = msg.backend === "local" ? LOCAL_MAX_TURN_MS : OPENAI_MAX_TURN_MS;
      }
      dispatch(msg);
    }, setStatus);
    const preroll: ArrayBuffer[] = [];

    startMicCapture(ctx, stream, ({ pcm, rms }) => {
      const event = gate.update(rms, performance.now());
      audioDebugRef.current = { ...audioDebugRef.current, rms, threshold: gate.threshold };
      if (event === "start") {
        setSpeaking(true);
        attributor.reset();
        turn += 1;
        socket.sendSpeechStart(turn);
        preroll.splice(0).forEach((frame) => socket.sendAudio(frame));
      }
      if (gate.isSpeaking || event === "commit") {
        socket.sendAudio(pcm);
        attributor.addVoicedFrame(facesRef.current ?? []);
      } else {
        preroll.push(pcm);
        if (preroll.length > PREROLL_FRAMES) preroll.shift();
      }
      if (event === "commit") {
        const speaker = attributor.finish();
        const thisTurn = turn;
        setTurnSpeakers((prev) => new Map(prev).set(thisTurn, speaker));
        audioDebugRef.current = {
          ...audioDebugRef.current,
          lastTurn: { turn: thisTurn, speaker, credits: attributor.lastCredits },
        };
        socket.sendCommit(thisTurn, speaker !== null);
        const attribution: Attribution = speaker !== null ? "face" : "caption_bar";
        if (timing.captioned.delete(thisTurn)) {
          trackEvent("zaru.hear.caption", {
            latency_ms: 0,
            before_commit: true,
            backend: sessionBackend ?? "unknown",
            attribution,
          });
        } else {
          timing.pending.set(thisTurn, { at: performance.now(), attribution });
          if (timing.pending.size > MAX_PENDING_TURNS) {
            timing.pending.delete(timing.pending.keys().next().value!);
          }
        }
        if (gate.isSpeaking) {
          // Forced commit on a long monologue: the speaker carries on in a new turn.
          turn += 1;
          socket.sendSpeechStart(turn);
        } else {
          setSpeaking(false);
        }
      }
    })
      .then((stop) => {
        if (cancelled) stop();
        else stopMic = stop;
      })
      .catch(() => {
        setMicError(true);
        socket.close();
      });

    return () => {
      cancelled = true;
      stopMic?.();
      socket.close();
    };
  }, [stream, ctx, facesRef]);

  return {
    captions,
    status: micError ? ("mic-error" as const) : status,
    speaking,
    backend,
    turnSpeakers,
    audioDebugRef,
  };
}
