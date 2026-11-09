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

/**
 * Zaru's voice. Uses speechSynthesis (not aria-live), so it never talks over VoiceOver's own
 * reading of the controls. One message at a time: urgent ones interrupt, others replace anything
 * still waiting, so the user only ever hears current information.
 */
export class Speaker {
  rate = loadRate();
  // Safari stops speaking mid-sentence if the utterance object is garbage-collected, so keep a
  // reference to whatever is queued or playing until it finishes.
  private live = new Set<SpeechSynthesisUtterance>();
  private keepAlive: number | undefined;

  get available(): boolean {
    return "speechSynthesis" in window;
  }

  /** True while something is being spoken or waiting to be spoken. */
  get busy(): boolean {
    return this.available && (this.live.size > 0 || window.speechSynthesis.speaking);
  }

  say(text: string, { interrupt = false }: { interrupt?: boolean } = {}): void {
    if (!this.available || !text.trim()) return;
    const synth = window.speechSynthesis;
    if (interrupt || this.live.size > 0) {
      // Drop anything older: stale narration is worse than none.
      synth.cancel();
      this.live.clear();
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.rate;
    utterance.lang = "en-US";
    const done = () => {
      this.live.delete(utterance);
      if (this.live.size === 0) window.clearInterval(this.keepAlive);
    };
    utterance.onend = done;
    utterance.onerror = done;
    this.live.add(utterance);
    // Chrome pauses long speech after ~15 s; a periodic resume keeps it going (no-op elsewhere).
    window.clearInterval(this.keepAlive);
    this.keepAlive = window.setInterval(() => synth.speaking && synth.resume(), 5000);
    synth.speak(utterance);
  }

  setRate(rate: number): void {
    this.rate = rate;
    saveRate(rate);
  }

  stop(): void {
    if (!this.available) return;
    window.speechSynthesis.cancel();
    this.live.clear();
    window.clearInterval(this.keepAlive);
  }
}
