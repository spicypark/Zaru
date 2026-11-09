/** Short generated sounds that tell a blind user what Zaru is doing (no vibration on iOS). */
export class Earcons {
  constructor(private readonly ctx: AudioContext) {}

  private tone(freq: number, startAt: number, duration: number, volume = 0.15): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }

  /** Rising pair: started listening for a question. */
  recordStart(): void {
    const t = this.ctx.currentTime;
    this.tone(660, t, 0.08);
    this.tone(880, t + 0.1, 0.1);
  }

  /** Falling pair: stopped listening. */
  recordStop(): void {
    const t = this.ctx.currentTime;
    this.tone(880, t, 0.08);
    this.tone(660, t + 0.1, 0.1);
  }

  /** Sharp double beep before a hazard warning. */
  hazard(): void {
    const t = this.ctx.currentTime;
    this.tone(1200, t, 0.07, 0.22);
    this.tone(1200, t + 0.12, 0.07, 0.22);
  }

  /** Soft tick every 0.7 s while waiting on the AI. Returns a stop function. */
  thinking(): () => void {
    this.tone(520, this.ctx.currentTime, 0.05, 0.06);
    const timer = window.setInterval(() => this.tone(520, this.ctx.currentTime, 0.05, 0.06), 700);
    return () => window.clearInterval(timer);
  }
}
