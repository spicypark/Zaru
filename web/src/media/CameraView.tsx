import { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream;
  mirrored: boolean;
  label: string;
};

export function CameraView({ stream, mirrored, label }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
  }, [stream]);

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
