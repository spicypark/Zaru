import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Three HTML entries so /see/ and /hear/ each carry their own manifest and home-screen icon.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        see: resolve(import.meta.dirname, "see/index.html"),
        hear: resolve(import.meta.dirname, "hear/index.html"),
      },
    },
  },
  server: {
    host: true,
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
});
