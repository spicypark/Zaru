const RATE_KEY = "zaru.speechRate";
export const DEFAULT_RATE = 1.1;

export function loadRate(): number {
  try {
    const value = Number(localStorage.getItem(RATE_KEY));
    return value >= 0.5 && value <= 2 ? value : DEFAULT_RATE;
  } catch {
    return DEFAULT_RATE;
  }
}

export function saveRate(rate: number): void {
  try {
    localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    /* ignore */
  }
}

// iOS WebKit truncates (or silently drops) an utterance spoken right after cancel(); wait this
// long after a cancel before speaking again.
const CANCEL_SETTLE_MS = 250;
// iOS often never fires `end`/`error` after a cancel or an audio interruption. Poll the engine and
// treat the utterance as finished once it has clearly stopped.
const POLL_MS = 300;
const MIN_SPEAK_MS = 800;
// Safety net: no single message of ours takes longer than this to say.
const MAX_SPEAK_MS = 20000;

type Message = { text: string; onStart?: () => void };

/**
 * Zaru's voice. Uses speechSynthesis (not aria-live), so it never talks over VoiceOver's own
 * reading of the controls.
 *
 * - One message plays at a time and is never chopped mid-sentence by routine updates: a newer
 *   update waits for the current one to finish, replacing any older waiting update (so the user
 *   only hears current information).
 * - `interrupt` (hazards, approaching people, the user's own actions) cancels what's playing and
 *   speaks after a short settle delay, which avoids iOS cutting the new message off.
 * - Completion is tracked by polling the engine as well as by events, so a lost `end` event can
 *   never leave the speaker believing it's still talking.
 */
export class Speaker {
  rate = loadRate();
  // Safari stops speaking mid-sentence if the utterance object is garbage-collected, so keep a
  // reference to the one playing until it finishes.
  private current: SpeechSynthesisUtterance | null = null;
  private currentStartedAt = 0;
  private pending: Message | null = null;
  private lastCancelAt = 0;
  private startTimer: number | undefined;
  private pollTimer: number | undefined;

  get available(): boolean {
    return "speechSynthesis" in window;
  }

  /** True while a message is playing or waiting to play. */
  get busy(): boolean {
    return this.current !== null || this.pending !== null || this.startTimer !== undefined;
  }

  /** `onStart` fires when the device actually begins speaking this message (if it does). */
  say(
    text: string,
    { interrupt = false, onStart }: { interrupt?: boolean; onStart?: () => void } = {},
  ): void {
    if (!this.available || !text.trim()) return;
    const message = { text, onStart };
    if (interrupt) {
      this.pending = null;
      this.cancelCurrent();
      this.schedule(message);
    } else if (this.current || this.startTimer !== undefined) {
      // Let the current message finish; keep only the newest update waiting.
      this.pending = message;
    } else {
      this.schedule(message);
    }
  }

  setRate(rate: number): void {
    this.rate = rate;
    saveRate(rate);
  }

  stop(): void {
    if (!this.available) return;
    this.pending = null;
    window.clearTimeout(this.startTimer);
    this.startTimer = undefined;
    this.cancelCurrent();
  }

  private cancelCurrent(): void {
    const synth = window.speechSynthesis;
    window.clearTimeout(this.startTimer);
    this.startTimer = undefined;
    if (this.current || synth.speaking || synth.pending) {
      synth.cancel();
      this.lastCancelAt = performance.now();
    }
    this.current = null;
    window.clearInterval(this.pollTimer);
  }

  private schedule(message: Message): void {
    window.clearTimeout(this.startTimer);
    this.startTimer = undefined;
    const wait = Math.max(0, this.lastCancelAt + CANCEL_SETTLE_MS - performance.now());
    if (wait === 0) {
      // Speak synchronously when we can: iOS only unlocks speech for the session if the first
      // speak() happens inside the user's tap, and a timer would lose that.
      this.speakNow(message);
      return;
    }
    this.startTimer = window.setTimeout(() => {
      this.startTimer = undefined;
      this.speakNow(message);
    }, wait);
  }

  private speakNow({ text, onStart }: Message): void {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.rate;
    utterance.lang = "en-US";
    if (onStart) utterance.onstart = onStart;
    const finish = () => this.finish(utterance);
    utterance.onend = finish;
    utterance.onerror = finish;
    this.current = utterance;
    this.currentStartedAt = performance.now();

    // iOS can leave the engine paused after an interruption, which silently swallows speech.
    if (synth.paused) synth.resume();
    synth.speak(utterance);

    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => {
      if (this.current !== utterance) return;
      const elapsed = performance.now() - this.currentStartedAt;
      const stopped = !synth.speaking && !synth.pending;
      if ((stopped && elapsed > MIN_SPEAK_MS) || elapsed > MAX_SPEAK_MS) finish();
    }, POLL_MS);
  }

  private finish(utterance: SpeechSynthesisUtterance): void {
    if (this.current !== utterance) return;
    this.current = null;
    window.clearInterval(this.pollTimer);
    const next = this.pending;
    this.pending = null;
    if (next) this.schedule(next);
  }
}
