export type SeeResult = {
  speak: string;
  priority: "hazard" | "people" | "text" | "scene" | "none" | string;
  changed: boolean;
  scene: string;
  question?: string | null;
};

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<SeeResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
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
