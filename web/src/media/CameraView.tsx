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
    void video.play().catch(() => {});
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
