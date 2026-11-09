// Copies the MediaPipe WASM runtime and downloads the vision models into public/mediapipe/ so
// the app serves them itself (no CDN dependency during the demo). Runs before dev and build.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "mediapipe");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");

const MODELS = {
  "face_landmarker.task":
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  "efficientdet_lite0.tflite":
    "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
};

mkdirSync(join(out, "wasm"), { recursive: true });
for (const file of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, file), join(out, "wasm", file));

for (const [name, url] of Object.entries(MODELS)) {
  const dest = join(out, name);
  if (existsSync(dest)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${name}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${name}`);
}
