import { goToMode } from "../modes";

export function Picker() {
  return (
    <main className="picker">
      <h1 className="brand">Zaru</h1>
      <button type="button" className="mode-card see" onClick={() => goToMode("see")}>
        <span className="mode-name">Zaru See</span>
        <span className="mode-desc">Spoken scene context for blind and low-vision attendees</span>
      </button>
      <button type="button" className="mode-card hear" onClick={() => goToMode("hear")}>
        <span className="mode-name">Zaru Hear</span>
        <span className="mode-desc">Live speech bubbles above whoever is talking</span>
      </button>
    </main>
  );
}
