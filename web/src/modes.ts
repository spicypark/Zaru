export type Mode = "see" | "hear";

export function currentMode(): Mode | null {
  const first = window.location.pathname.split("/").filter(Boolean)[0];
  return first === "see" || first === "hear" ? first : null;
}

export function goToMode(mode: Mode): void {
  window.location.assign(`/${mode}/`);
}

export function goToPicker(): void {
  window.location.assign("/");
}
