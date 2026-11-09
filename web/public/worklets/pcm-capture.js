// Converts microphone audio to mono PCM16 at 24 kHz in 100 ms frames, with each frame's RMS level.
// Runs on the audio thread; `sampleRate` is the AudioContext's rate. When the browser honours our
// 24 kHz request this is a pass-through. Otherwise (e.g. iOS at 48 kHz) each output sample is the
// average of the input samples it covers: a box low-pass filter, so frequencies above 12 kHz
// don't alias down into the speech band the way plain sample-dropping would.
const TARGET_RATE = 24000;
const FRAME_SAMPLES = TARGET_RATE / 10;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.phase = 0;
    this.pos = 0;
    this.prev = 0;
    this.acc = 0;
    this.accCount = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.count = 0;
    this.sumSquares = 0;
  }

  emit(value) {
    const s = Math.max(-1, Math.min(1, value));
    this.frame[this.count++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    this.sumSquares += s * s;
    if (this.count === FRAME_SAMPLES) {
      const rms = Math.sqrt(this.sumSquares / FRAME_SAMPLES);
      this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer]);
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.count = 0;
      this.sumSquares = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    if (this.step < 1) {
      // Context below 24 kHz (e.g. a 16 kHz Bluetooth headset mic): upsample by linear
      // interpolation, so each input sample yields ~1/step output samples. `pos` is the read
      // position relative to this block; values in [-1, 0) interpolate from the previous block.
      while (this.pos < channel.length - 1) {
        const i = Math.floor(this.pos);
        const a = i < 0 ? this.prev : channel[i];
        const b = channel[i + 1];
        this.emit(a + (b - a) * (this.pos - i));
        this.pos += this.step;
      }
      this.pos -= channel.length;
      this.prev = channel[channel.length - 1];
      return true;
    }

    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i];
      this.accCount += 1;
      this.phase += 1;
      if (this.phase >= this.step) {
        this.phase -= this.step;
        this.emit(this.acc / this.accCount);
        this.acc = 0;
        this.accCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
