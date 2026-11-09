import { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream;
  mirrored: boolean;
  label: string;
  /** Receives the <video> element (or null on unmount), e.g. for on-device vision. */
  onVideo?: (video: HTMLVideoElement | null) => void;
};

export function CameraView({ stream, mirrored, label, onVideo }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    const play = () => void video.play().catch(() => {});
    play();
    // iOS pauses the <video> when the app is backgrounded or the stream is interrupted; resume
    // it as soon as possible so the camera keeps showing (and feeding the vision models).
    const onVisible = () => document.visibilityState === "visible" && play();
    video.addEventListener("pause", play);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      video.removeEventListener("pause", play);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [stream]);

  useEffect(() => {
    onVideo?.(ref.current);
    return () => onVideo?.(null);
  }, [onVideo]);

  return (
    <video
      ref={ref}
      className={mirrored ? "camera mirrored" : "camera"}
      aria-label={label}
      autoPlay
      muted
      playsInline
    />
  );
}
