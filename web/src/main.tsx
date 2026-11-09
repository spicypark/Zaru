import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, redirectToLastMode } from "./App";
import "./styles.css";
import { initTelemetry } from "./telemetry";

initTelemetry();

if (!redirectToLastMode()) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
