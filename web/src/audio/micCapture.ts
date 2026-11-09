export type MicFrame = { pcm: ArrayBuffer; rms: number };

/** Streams 100 ms PCM16/24 kHz frames from the stream's microphone. Returns a stop function. */
export async function startMicCapture(
  ctx: AudioContext,
  stream: MediaStream,
  onFrame: (frame: MicFrame) => void,
): Promise<() => void> {
  await ctx.audioWorklet.addModule("/worklets/pcm-capture.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  // Some browsers only run a worklet that is connected to the output; keep it silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;

  node.port.onmessage = (event: MessageEvent<MicFrame>) => onFrame(event.data);
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  return () => {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    mute.disconnect();
  };
}
