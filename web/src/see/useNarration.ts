import { useEffect, useRef, useState, type RefObject } from "react";
import type { ObjectDetector } from "@mediapipe/tasks-vision";
import { Earcons } from "../audio/earcons";
import { ApproachTracker, createPersonDetector } from "../cv/personDetector";
import { describe } from "./api";
import { captureJpeg, clockDirection, difference, thumbnail } from "./frames";
import { trackEvent, type NarrationReason, type RumEvents } from "../telemetry";
import type { Speaker } from "./speech";

// --- When to speak: a running narration that adapts to how much the view changes -------------
const TICK_MS = 400;
// Mean grey difference (32×32 thumbnails) between now and the last narrated view.
const BIG_CHANGE = 0.14;
const MODERATE_CHANGE = 0.06;
// Motion between consecutive ticks below this counts as "settled" (sharp photo).
const SETTLED_MOTION = 0.025;
const SETTLED_TICKS = 2;
// While walking the view never settles; narrate anyway after this much continuous motion.
const WALKING_MS = 2500;
const MIN_GAP_BIG_MS = 2500;
const MIN_GAP_MODERATE_MS = 6000;
// When nothing changes, reminders back off from 8 s up to 40 s, and reset on any change.
// Reminders only after this much silence, growing up to the max while nothing changes.
const QUIET_START_MS = 20000;
const QUIET_MAX_MS = 60000;
const QUIET_GROWTH = 1.5;
// How many recent spoken lines the model sees, so it doesn't repeat itself.
const HISTORY_LINES = 4;
// Safety net: skip a non-urgent line this similar (word overlap) to something said recently.
const REPEAT_SIMILARITY = 0.6;

const words = (text: string) =>
  new Set(text.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length > 2));

/** Word-overlap similarity (0..1) between two sentences. */
function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}
// A camera that delivers no new frames for this long has frozen.
const FROZEN_MS = 3000;
// Person detector cadence and the minimum gap between approach alerts.
const PERSON_INTERVAL_MS = 250;
const APPROACH_GAP_MS = 5000;

const PRIORITIES = ["hazard", "people", "text", "scene", "none"] as const;
type Priority = RumEvents["zaru.see.time_to_speech"]["priority"];
// The priority comes from the model; only ever report one of the known values.
const knownPriority = (value: string): Priority =>
  (PRIORITIES as readonly string[]).includes(value) ? (value as Priority) : "other";

export type NarrationStatus = "stopped" | "looking" | "listening";

/** A new spoken update, for the screen's visual cue (no text: the point is speech). */
export type Pulse = { id: number; priority: string };

type Options = {
  running: boolean;
  video: HTMLVideoElement | null;
  ctx: AudioContext | null;
  mirrored: boolean;
  speaker: Speaker;
  /** Called when the camera feed looks frozen, so the caller can reopen the camera. */
  onFrozen: () => void;
  /** While true (the user is asking a question), narration and approach alerts hold off. */
  holdRef?: RefObject<boolean>;
};

/**
 * Zaru See's continuous narration: watches the camera on-device and asks the vision model for an
 * update when the view changes enough, when something urgent appears, or (with growing gaps)
 * when nothing has changed, so the user always has a current picture without constant chatter.
 */
export function useNarration({
  running,
  video,
  ctx,
  mirrored,
  speaker,
  onFrozen,
  holdRef,
}: Options) {
  const [status, setStatus] = useState<"looking" | "listening">("listening");
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const pulseIdRef = useRef(0);
  const onFrozenRef = useRef(onFrozen);
  const lastApproachRef = useRef(0);

  useEffect(() => {
    onFrozenRef.current = onFrozen;
  }, [onFrozen]);

  // Narration loop.
  useEffect(() => {
    if (!running || !video) return;
    const earcons = ctx ? new Earcons(ctx) : null;
    let stopped = false;
    let inFlight = false;
    let previousThumb: Float32Array | null = null;
    let lastSentThumb: Float32Array | null = null;
    // What Zaru actually said recently (oldest first); sent to the model so it won't repeat.
    const history: string[] = [];
    let lastUpdateAt = 0;
    let lastSpokenAt = performance.now();
    let quietInterval = QUIET_START_MS;
    let settledTicks = 0;
    let movingSince = 0;
    // Time of the last new camera frame: one callback per decoded frame where supported
    // (Safari 15.4+, Chrome), otherwise any change in the video's playback time.
    let lastFrameAt = performance.now();
    let lastVideoTime = -1;
    // Older browsers lack it even though the DOM typings always declare it.
    const frameCallbacks =
      typeof (video as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback ===
      "function";
    let frameHandle = 0;
    const onFrame = () => {
      lastFrameAt = performance.now();
      if (!stopped) frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    if (frameCallbacks) frameHandle = video.requestVideoFrameCallback(onFrame);
    const pollFrames = () => {
      if (frameCallbacks) return;
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        lastFrameAt = performance.now();
      }
    };
    let pausedUntil = 0;

    const narrate = async (thumb: Float32Array, reason: NarrationReason) => {
      const triggeredAt = performance.now();
      const image = captureJpeg(video);
      if (!image) return;
      inFlight = true;
      lastUpdateAt = performance.now();
      lastSentThumb = thumb;
      setStatus("looking");
      try {
        const recent = history.join(" | ");
        const result = await describe(image, "update", recent, reason);
        // Dropped if narration stopped, or the user started asking a question meanwhile.
        if (stopped || holdRef?.current) return;
        const requestMs = performance.now() - triggeredAt;
        // Something new: reminders stay at the base interval. Nothing new: space them further.
        quietInterval = result.changed
          ? QUIET_START_MS
          : Math.min(QUIET_MAX_MS, quietInterval * QUIET_GROWTH);
        const urgent = result.priority === "hazard";
        // Reminders are deliberate "Still …" repeats, so they skip the near-repeat filter. Either
        // way a reminder request restarts the quiet clock, so a still scene can't trigger a new
        // vision call every few seconds.
        const reminder = reason === "reminder";
        if (reminder) lastSpokenAt = performance.now();
        const repeated =
          !urgent &&
          !reminder &&
          history.some((line) => similarity(line, result.speak) >= REPEAT_SIMILARITY);
        if (result.speak && !repeated) {
          history.push(result.speak);
          if (history.length > HISTORY_LINES) history.shift();
          lastSpokenAt = performance.now();
          if (urgent) earcons?.hazard();
          const priority = knownPriority(result.priority);
          speaker.say(result.speak, {
            interrupt: urgent,
            onStart: () =>
              trackEvent("zaru.see.time_to_speech", {
                duration_ms: performance.now() - triggeredAt,
                request_ms: requestMs,
                reason,
                priority,
              }),
          });
          pulseIdRef.current += 1;
          setPulse({ id: pulseIdRef.current, priority: result.priority });
        }
      } catch (err) {
        if (stopped) return;
        const unconfigured = err instanceof Error && err.message === "unconfigured";
        speaker.say(
          unconfigured
            ? "Scene descriptions aren't set up on this server."
            : "I lost the connection. I'll keep trying.",
        );
        pausedUntil = performance.now() + (unconfigured ? 60000 : 5000);
      } finally {
        inFlight = false;
        if (!stopped) setStatus("listening");
      }
    };

    const tick = () => {
      if (stopped) return;
      const now = performance.now();
      pollFrames();
      const thumb = thumbnail(video);

      // Frozen camera: the video has stopped delivering new frames. (Comparing pixels is not a
      // safe signal: a still scene with heavy noise reduction can give identical thumbnails.)
      // Hidden pages render no frames (and can't reopen the camera on iOS), so only judge
      // freezes while visible; the media hook reopens a dead camera on return.
      if (document.visibilityState !== "visible") {
        lastFrameAt = now;
      } else if (now - lastFrameAt > FROZEN_MS) {
        lastFrameAt = now; // give the restart time before checking again
        onFrozenRef.current();
      }
      if (!thumb) return;

      const motion = previousThumb ? difference(previousThumb, thumb) : 1;
      previousThumb = thumb;
      if (motion < SETTLED_MOTION) {
        settledTicks += 1;
        movingSince = 0;
      } else {
        settledTicks = 0;
        movingSince ||= now;
      }

      if (inFlight || now < pausedUntil || holdRef?.current) return;
      const sinceLast = now - lastUpdateAt;
      const change = lastSentThumb ? difference(lastSentThumb, thumb) : 1;
      const settled = settledTicks >= SETTLED_TICKS;
      const walking = movingSince > 0 && now - movingSince > WALKING_MS;
      const speaking = speaker.busy;

      if (!lastSentThumb) {
        void narrate(thumb, "start");
      } else if (change > BIG_CHANGE && (settled || walking) && sinceLast > MIN_GAP_BIG_MS) {
        void narrate(thumb, "big_change");
      } else if (
        change > MODERATE_CHANGE &&
        settled &&
        !speaking &&
        sinceLast > MIN_GAP_MODERATE_MS
      ) {
        void narrate(thumb, "change");
      } else if (
        !speaking &&
        now - lastSpokenAt > quietInterval &&
        sinceLast > MIN_GAP_MODERATE_MS
      ) {
        void narrate(thumb, "reminder");
      }
    };

    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      if (frameCallbacks && frameHandle) video.cancelVideoFrameCallback(frameHandle);
      speaker.stop();
    };
  }, [running, video, ctx, speaker, holdRef]);

  // On-device person detector: instant "person approaching" without waiting on the model.
  useEffect(() => {
    if (!running || !video) return;
    const earcons = ctx ? new Earcons(ctx) : null;
    let detector: ObjectDetector | null = null;
    let stopped = false;
    let timestamp = 0;
    const tracker = new ApproachTracker();

    const timer = window.setInterval(() => {
      if (!detector || !video.videoWidth) return;
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
        const now = performance.now();
        for (const event of tracker.update(boxes, now)) {
          if (holdRef?.current || now - lastApproachRef.current < APPROACH_GAP_MS) continue;
          lastApproachRef.current = now;
          trackEvent("zaru.see.person_approach", {});
          earcons?.hazard();
          speaker.say(`Person approaching, ${clockDirection(event.x, mirrored)}.`, {
            interrupt: true,
          });
          pulseIdRef.current += 1;
          setPulse({ id: pulseIdRef.current, priority: "approach" });
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
  }, [running, video, ctx, mirrored, speaker, holdRef]);

  return { status: (running ? status : "stopped") as NarrationStatus, pulse };
}
