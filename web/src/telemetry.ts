import { init } from "@dash0/sdk-web";

// Real-user monitoring via Dash0. Disabled unless the build has an endpoint and ingest token.
// Session recording and profiling stay off: the screen shows a live camera feed of people.
export function initTelemetry(): void {
  const url = import.meta.env.VITE_DASH0_ENDPOINT;
  const authToken = import.meta.env.VITE_DASH0_AUTH_TOKEN;
  if (!url || !authToken) return;

  init({
    serviceName: "zaru-web",
    environment: import.meta.env.MODE,
    endpoint: { url, authToken, dataset: import.meta.env.VITE_DASH0_DATASET || "default" },
    enabledInstrumentations: [
      "@dash0/navigation",
      "@dash0/web-vitals",
      "@dash0/error",
      "@dash0/fetch",
      "@dash0/xhr",
      "@dash0/frustration-signals",
    ],
  });
}
