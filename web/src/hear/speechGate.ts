export type GateEvent = "start" | "commit" | null;

/**
 * Energy-based voice activity detector over 100 ms RMS levels.
 * - "start" when the level rises above an adaptive noise floor
 * - "commit" after `hangMs` of quiet (end of a turn), or every `maxTurnMs` of continuous speech
 *   so long monologues still caption promptly.
 */
export class SpeechGate {
  private noiseFloor = 0.01;
  private speaking = false;
  private lastVoiceAt = 0;
  private turnStartedAt = 0;

  constructor(
    private readonly hangMs = 600,
    private readonly maxTurnMs = 5000,
    private readonly minThreshold = 0.015,
  ) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get threshold(): number {
    return Math.max(this.minThreshold, this.noiseFloor * 3);
  }

  update(rms: number, now: number): GateEvent {
    const voiced = rms > this.threshold;
    // Follow the room's background level quickly while quiet, and drift up slowly while
    // "voiced" so a sustained rise in ambient noise (a crowd, HVAC) is eventually absorbed
    // instead of holding the gate open forever.
    const alpha = voiced ? 0.002 : 0.05;
    this.noiseFloor = this.noiseFloor * (1 - alpha) + rms * alpha;

    if (voiced) {
      this.lastVoiceAt = now;
      if (!this.speaking) {
        this.speaking = true;
        this.turnStartedAt = now;
        return "start";
      }
      if (now - this.turnStartedAt >= this.maxTurnMs) {
        this.turnStartedAt = now;
        return "commit";
      }
      return null;
    }

    if (this.speaking && now - this.lastVoiceAt >= this.hangMs) {
      this.speaking = false;
      return "commit";
    }
    return null;
  }
}
