// Converts microphone audio to mono PCM16 at 24 kHz in 100 ms frames, with each frame's RMS level.
// Runs on the audio thread; `sampleRate` is the AudioContext's rate (24 kHz when the browser
// honours our request, otherwise e.g. 48 kHz, which we decimate here).
const TARGET_RATE = 24000;
const FRAME_SAMPLES = TARGET_RATE / 10;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.pos = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.count = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    while (this.pos < channel.length) {
      const s = Math.max(-1, Math.min(1, channel[Math.floor(this.pos)]));
      this.frame[this.count++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSquares += s * s;
      if (this.count === FRAME_SAMPLES) {
        const rms = Math.sqrt(this.sumSquares / FRAME_SAMPLES);
        this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer]);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.count = 0;
        this.sumSquares = 0;
      }
      this.pos += this.step;
    }
    this.pos -= channel.length;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
