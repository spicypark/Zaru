export type GateEvent = "start" | "commit" | null;

// Background level = this percentile of the last HISTORY_FRAMES levels (100 ms each). A running
// average learns from the speech itself: in a continuous conversation there's no quiet stretch,
// so the floor (and a 3× threshold) climbed above normal speech and the gate went deaf. Tested
// on a recorded two-person conversation, that version covered 27% of the speech; this one, 93%.
const HISTORY_FRAMES = 100;
const FLOOR_PERCENTILE = 0.15;
// Hysteresis: a higher bar to start a turn than to keep it going through soft syllables.
const START_FACTOR = 2.2;
const KEEP_FACTOR = 1.6;

/**
 * Energy-based voice activity detector over 100 ms RMS levels.
 * - "start" when the level rises clearly above the room's background
 * - "commit" after `hangMs` of quiet (end of a turn), or every `maxTurnMs` of continuous speech
 *   so long monologues still caption promptly.
 */
export class SpeechGate {
  private recent: number[] = [];
  private floor = 0.01;
  private speaking = false;
  private lastVoiceAt = 0;
  private turnStartedAt = 0;

  constructor(
    /**
     * Adjustable: short (500 ms) on OpenAI so quick back-and-forth splits into separate turns
     * (and separate bubbles); longer for the local Whisper fallback, which needs whole sentences.
     */
    public hangMs = 800,
    /** Adjustable: the local Whisper fallback is more accurate on longer, whole sentences. */
    public maxTurnMs = 5000,
    private readonly minThreshold = 0.01,
  ) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get threshold(): number {
    return Math.max(this.minThreshold, this.floor * (this.speaking ? KEEP_FACTOR : START_FACTOR));
  }

  private updateFloor(rms: number): void {
    this.recent.push(rms);
    if (this.recent.length > HISTORY_FRAMES) this.recent.shift();
    if (this.recent.length < 10) return;
    const sorted = [...this.recent].sort((a, b) => a - b);
    this.floor = sorted[Math.floor((sorted.length - 1) * FLOOR_PERCENTILE)];
  }

  update(rms: number, now: number): GateEvent {
    this.updateFloor(rms);
    const voiced = rms > this.threshold;

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
