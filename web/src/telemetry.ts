import { init, sendEvent } from "@dash0/sdk-web";

let enabled = false;

// Real-user monitoring via Dash0. Disabled unless the build has an endpoint and ingest token.
// Session recording and profiling stay off: the screen shows a live camera feed of people.
export function initTelemetry(): void {
  const url = import.meta.env.VITE_DASH0_ENDPOINT;
  const authToken = import.meta.env.VITE_DASH0_AUTH_TOKEN;
  if (!url || !authToken) return;

  init({
    serviceName: "zaru-web",
    environment: import.meta.env.MODE,
    endpoint: { url, authToken, dataset: import.meta.env.VITE_DASH0_DATASET || "default" },
    enabledInstrumentations: [
      "@dash0/navigation",
      "@dash0/web-vitals",
      "@dash0/error",
      "@dash0/fetch",
      "@dash0/xhr",
      "@dash0/frustration-signals",
    ],
  });
  enabled = true;
}

export type NarrationReason = "start" | "big_change" | "change" | "reminder";
export type CameraRestartReason = "ended" | "muted" | "frozen" | "visible";

/**
 * Product events sent to Dash0 RUM. Privacy: numbers and fixed enums only. Never add a field
 * that could hold transcript text, narration text, or anything else a person said or the
 * camera saw.
 */
export type RumEvents = {
  /** Narration trigger to speechSynthesis starting to speak; request_ms is the vision call. */
  "zaru.see.time_to_speech": {
    duration_ms: number;
    request_ms: number;
    reason: NarrationReason;
    priority: "hazard" | "people" | "text" | "scene" | "none" | "other";
  };
  "zaru.see.narration": { state: "paused" | "resumed" };
  "zaru.see.person_approach": Record<string, never>;
  "zaru.camera.restart": {
    mode: "see" | "hear";
    reason: CameraRestartReason;
    outcome: "ok" | "failed";
    duration_ms: number;
  };
  /**
   * One per captioned turn: end of the turn (commit) to its first caption on screen, and where
   * the turn was shown. Streamed words can be on screen before the turn ends: latency 0.
   */
  "zaru.hear.caption": {
    latency_ms: number;
    before_commit: boolean;
    backend: "openai" | "local" | "unknown";
    attribution: "face" | "caption_bar";
  };
  /** Sampled about every 30 s while Hear is running. */
  "zaru.hear.face_detector": { delegate: "GPU" | "CPU"; fps: number; errors: number };
  /** Sent once the socket is back, not per attempt. */
  "zaru.hear.socket_reconnect": { attempts: number; downtime_ms: number };
};

/** Sends a product event; a no-op when Dash0 is not configured. Never throws. */
export function trackEvent<K extends keyof RumEvents>(name: K, fields: RumEvents[K]): void {
  if (!enabled) return;
  try {
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      attributes[`zaru.${key}`] = typeof value === "number" ? Math.round(value) : value;
    }
    sendEvent(name, { attributes });
  } catch {
    // Telemetry must never break the app.
  }
}
