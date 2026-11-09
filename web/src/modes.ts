export type Mode = "see" | "hear";

const KEY = "zaru.lastMode";

export function currentMode(): Mode | null {
  const first = window.location.pathname.split("/").filter(Boolean)[0];
  return first === "see" || first === "hear" ? first : null;
}

// Storage can throw (private mode, blocked site data); the app must work without it.
export function rememberMode(mode: Mode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
}

export function lastMode(): Mode | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "see" || value === "hear" ? value : null;
  } catch {
    return null;
  }
}

export function goToMode(mode: Mode): void {
  window.location.assign(`/${mode}/`);
}

export function goToPicker(): void {
  window.location.assign("/?pick=1");
}
