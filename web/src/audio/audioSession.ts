/**
 * iOS audio session (Safari 16.4+ `navigator.audioSession`; a no-op elsewhere).
 *
 * - "playback": loudspeaker output that ignores the ring/silent switch. Without it, iOS treats web
 *   audio as "ambient", so with the phone on silent Zaru's voice only came through AirPods.
 * - "play-and-record": needed while the mic is open (Hear, See's Ask). In this mode iOS routes
 *   output like a phone call, so See switches back to "playback" as soon as recording ends.
 */
export type AudioSessionType = "playback" | "play-and-record" | "auto";

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

export function setAudioSession(type: AudioSessionType): void {
  const session = (navigator as AudioSessionNavigator).audioSession;
  if (!session) return;
  try {
    session.type = type;
  } catch {
    // Unsupported value on this version: keep the default.
  }
}
