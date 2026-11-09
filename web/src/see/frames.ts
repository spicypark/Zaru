/** JPEG data URL of the current video frame, scaled so its longest side is `maxSide`. */
export function captureJpeg(video: HTMLVideoElement, maxSide = 768, quality = 0.7): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

const THUMB = 32;
const thumbCanvas = document.createElement("canvas");
thumbCanvas.width = THUMB;
thumbCanvas.height = THUMB;
const thumbCtx = thumbCanvas.getContext("2d", { willReadFrequently: true })!;

/** 32×32 greyscale (0..1) thumbnail used to notice when the view changes. */
export function thumbnail(video: HTMLVideoElement): Float32Array | null {
  if (!video.videoWidth) return null;
  thumbCtx.drawImage(video, 0, 0, THUMB, THUMB);
  const { data } = thumbCtx.getImageData(0, 0, THUMB, THUMB);
  const out = new Float32Array(THUMB * THUMB);
  for (let i = 0; i < out.length; i++) {
    out[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  }
  return out;
}

/** Mean absolute difference between two thumbnails (0 = identical, ~0.5 = very different). */
export function difference(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Clock direction (10..2 o'clock) for a horizontal position 0..1 across the camera frame. */
export function clockDirection(x: number, mirrored = false): string {
  const pos = mirrored ? 1 - x : x;
  const hour = Math.round(10 + Math.min(1, Math.max(0, pos)) * 4);
  return `${hour > 12 ? hour - 12 : hour} o'clock`;
}
