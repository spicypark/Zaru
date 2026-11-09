type Sentinel = { release: () => Promise<void>; released: boolean };
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<Sentinel> };
};

/**
 * Keeps the screen on while Zaru is narrating. If the phone auto-locks, iOS stops the camera.
 * The lock is dropped when the page is hidden, so it's re-requested when the page comes back.
 * Returns a function that releases it.
 */
export function keepScreenOn(): () => void {
  const nav = navigator as WakeLockNavigator;
  if (!nav.wakeLock) return () => {};
  let sentinel: Sentinel | null = null;
  let active = true;

  const acquire = async () => {
    if (!active || document.visibilityState !== "visible") return;
    try {
      sentinel = await nav.wakeLock!.request("screen");
    } catch {
      // Not allowed (low battery, etc.): carry on without it.
    }
  };
  const onVisible = () => {
    if (!sentinel || sentinel.released) void acquire();
  };

  void acquire();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    active = false;
    document.removeEventListener("visibilitychange", onVisible);
    void sentinel?.release().catch(() => {});
  };
}
