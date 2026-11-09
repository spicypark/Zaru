import { currentMode } from "./modes";
import { HearScreen } from "./screens/HearScreen";
import { Picker } from "./screens/Picker";
import { SeeScreen } from "./screens/SeeScreen";

/**
 * "/" always shows the picker with both modes. /see/ and /hear/ (and their home-screen icons)
 * open a mode directly. No "last used mode" memory: reopening into the other mode was confusing.
 */
export function App() {
  const mode = currentMode();
  if (mode === "see") return <SeeScreen />;
  if (mode === "hear") return <HearScreen />;
  return <Picker />;
}
