/**
 * Create (and resume) the AudioContext inside a user gesture: iOS keeps it suspended otherwise.
 * We ask for 24 kHz so the worklet doesn't need to resample; browsers that refuse get their default.
 */
export function createAudioContext(): AudioContext {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 24000 });
  } catch {
    ctx = new AudioContext();
  }
  void ctx.resume().catch(() => {});
  return ctx;
}
