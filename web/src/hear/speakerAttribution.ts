import type { TrackedFace } from "../cv/faceTracker";

// A face must have moved its mouth this much (summed over voiced 100 ms frames) to own a turn,
// and clearly more than the runner-up, otherwise the caption goes to the caption bar.
const MIN_TOTAL_ACTIVITY = 0.025;
const MIN_LEAD_RATIO = 1.25;

/**
 * Decides who spoke a turn: while the speech gate says someone is talking, each audio frame
 * credits every visible face with its current mouth activity. At the end of the turn the face
 * with the clear lead is the speaker.
 */
export class TurnAttributor {
  private credit = new Map<number, number>();
  /** The last finished turn's per-face credit, highest first (for the debug overlay). */
  lastCredits: [number, number][] = [];

  reset(): void {
    this.credit.clear();
  }

  addVoicedFrame(faces: TrackedFace[]): void {
    for (const face of faces) {
      this.credit.set(face.id, (this.credit.get(face.id) ?? 0) + face.activity);
    }
  }

  /** Returns the speaking face's id, or null if no face clearly spoke. Resets for the next turn. */
  finish(): number | null {
    const ranked = [...this.credit.entries()].sort((a, b) => b[1] - a[1]);
    this.lastCredits = ranked;
    this.credit.clear();
    const [best, second] = ranked;
    if (!best || best[1] < MIN_TOTAL_ACTIVITY) return null;
    if (second && best[1] < second[1] * MIN_LEAD_RATIO) return null;
    return best[0];
  }
}
