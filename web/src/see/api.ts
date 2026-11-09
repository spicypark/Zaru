export type SeeResult = {
  speak: string;
  priority: "hazard" | "people" | "text" | "scene" | "none" | string;
  changed: boolean;
  scene: string;
  question?: string | null;
};

// Longer than the slowest normal request (Ask: transcription + vision, ~5 s), short enough
// that a stalled connection can't lock out Ask or narration for long.
const REQUEST_TIMEOUT_MS = 20000;

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<SeeResult> {
  // Plain AbortController + timer (AbortSignal.any/timeout need newer iOS than we target).
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward);
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
  if (!res.ok) throw new Error(res.status === 503 ? "unconfigured" : `http_${res.status}`);
  return (await res.json()) as SeeResult;
}

export function describe(
  image: string,
  mode: "update" | "auto" | "describe",
  previous = "",
  reason = "",
  signal?: AbortSignal,
): Promise<SeeResult> {
  return post("/api/see/describe", { image, mode, previous, reason }, signal);
}

/** A spoken question (base64 WAV) about the current frame: transcribed, then answered. */
export function ask(image: string, audio: string): Promise<SeeResult> {
  return post("/api/see/ask", { image, audio });
}
