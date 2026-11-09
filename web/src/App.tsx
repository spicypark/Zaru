import { useEffect } from "react";
import { currentMode, lastMode, rememberMode } from "./modes";
import { HearScreen } from "./screens/HearScreen";
import { Picker } from "./screens/Picker";
import { SeeScreen } from "./screens/SeeScreen";

export function App() {
  const mode = currentMode();

  useEffect(() => {
    if (mode) rememberMode(mode);
  }, [mode]);

  if (mode === "see") return <SeeScreen />;
  if (mode === "hear") return <HearScreen />;
  return <Picker />;
}

/** On "/", reopen the last-used mode unless the user explicitly asked for the picker. */
export function redirectToLastMode(): boolean {
  if (currentMode()) return false;
  if (new URLSearchParams(window.location.search).has("pick")) return false;
  const last = lastMode();
  if (!last) return false;
  window.location.replace(`/${last}/`);
  return true;
}
