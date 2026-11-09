import type { Box } from "./faceTracker";

export type ScreenRect = { left: number; top: number; width: number; height: number };

/**
 * Maps a normalised box in the camera frame to pixels inside the <video> element, which uses
 * `object-fit: cover` (scaled to fill, edges cropped) and may be mirrored with scaleX(-1).
 */
export function boxToScreen(box: Box, video: HTMLVideoElement, mirrored: boolean): ScreenRect {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const ew = video.clientWidth;
  const eh = video.clientHeight;
  const scale = Math.max(ew / vw, eh / vh);
  const offsetX = (vw * scale - ew) / 2;
  const offsetY = (vh * scale - eh) / 2;

  const width = box.w * vw * scale;
  const height = box.h * vh * scale;
  let left = box.x * vw * scale - offsetX;
  const top = box.y * vh * scale - offsetY;
  if (mirrored) left = ew - left - width;
  return { left, top, width, height };
}
