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
 * reading of the controls. Urgent messages interrupt; others wait their turn.
 */
export class Speaker {
  rate = loadRate();
  private speakingUntil = 0;

  get available(): boolean {
    return "speechSynthesis" in window;
  }

  get busy(): boolean {
    return this.available && (window.speechSynthesis.speaking || Date.now() < this.speakingUntil);
  }

  say(text: string, { interrupt = false }: { interrupt?: boolean } = {}): void {
    if (!this.available || !text.trim()) return;
    if (interrupt) window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.rate;
    utterance.lang = "en-US";
    // speechSynthesis.speaking can lag on iOS; keep our own estimate too.
    this.speakingUntil = Date.now() + Math.min(15000, (text.length * 70) / this.rate);
    utterance.onend = () => (this.speakingUntil = 0);
    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    if (!this.available) return;
    window.speechSynthesis.cancel();
    this.speakingUntil = 0;
  }
}
