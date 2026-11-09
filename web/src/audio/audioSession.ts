/**
 * iOS audio session (Safari 16.4+ `navigator.audioSession`; a no-op elsewhere).
 *
 * - "play-and-record": while the mic is open (Hear, See's Ask). iOS routes output like a phone
 *   call in this mode, so See returns to "auto" as soon as recording ends.
 * - "auto": iOS's default. Note: forcing "playback" (to ignore the silent switch) silenced
 *   speechSynthesis on iPhone, so See doesn't use it; on silent, Zaru's voice may only play
 *   through headphones.
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
