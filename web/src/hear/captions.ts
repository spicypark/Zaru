import type { ServerMessage } from "./hearSocket";

export type Caption = {
  item: string;
  /** The phone's turn number, used to look up which face spoke it. */
  turn: number | null;
  text: string;
  final: boolean;
  updatedAt: number;
};

const MAX_CAPTIONS = 6;

/** Captions keyed by transcription item, in the order they started. */
export function captionsReducer(captions: Caption[], msg: ServerMessage): Caption[] {
  if (msg.type !== "delta" && msg.type !== "final" && msg.type !== "failed") return captions;

  const now = Date.now();
  const index = captions.findIndex((c) => c.item === msg.item);

  if (msg.type === "failed") {
    return index === -1 ? captions : captions.filter((_, i) => i !== index);
  }

  const existing = index === -1 ? null : captions[index];
  const text = msg.type === "final" ? msg.text.trim() : (existing?.text ?? "") + msg.text;
  if (msg.type === "final" && !text) {
    return index === -1 ? captions : captions.filter((_, i) => i !== index);
  }

  const next: Caption = {
    item: msg.item,
    turn: msg.turn ?? existing?.turn ?? null,
    text,
    final: msg.type === "final",
    updatedAt: now,
  };
  const updated =
    index === -1 ? [...captions, next] : captions.map((c, i) => (i === index ? next : c));
  return updated.slice(-MAX_CAPTIONS);
}
