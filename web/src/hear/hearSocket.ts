import { trackEvent } from "../telemetry";

export type CaptionBackend = "openai" | "local";

export type ServerMessage =
  | { type: "ready"; backend?: CaptionBackend }
  | { type: "delta"; item: string; turn?: number | null; text: string }
  | { type: "final"; item: string; turn?: number | null; text: string }
  | { type: "failed"; item: string; turn?: number | null }
  | { type: "error"; code: string };

export type SocketStatus = "connecting" | "ready" | "reconnecting" | "unavailable";

const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

function hearUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws/hear`;
}

/** WebSocket to /ws/hear with automatic reconnect. */
export class HearSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private retryTimer: number | undefined;
  private droppedAt = 0;

  constructor(
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onStatus: (status: SocketStatus) => void,
  ) {
    this.connect();
  }

  get isReady(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.isReady) this.ws!.send(pcm);
  }

  /** Someone started talking; words streamed before the commit are tagged with `turn`. */
  sendSpeechStart(turn: number): void {
    if (this.isReady) this.ws!.send(JSON.stringify({ type: "speech_start", turn }));
  }

  /** End of a spoken turn; `turn` comes back on that turn's captions. */
  sendCommit(turn: number, attributed: boolean): void {
    if (this.isReady) this.ws!.send(JSON.stringify({ type: "commit", turn, attributed }));
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  private connect(): void {
    this.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(hearUrl());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const msg = JSON.parse(event.data) as ServerMessage;
      if (msg.type === "ready") {
        if (this.attempt > 0) {
          trackEvent("zaru.hear.socket_reconnect", {
            attempts: this.attempt,
            downtime_ms: performance.now() - this.droppedAt,
          });
        }
        this.attempt = 0;
        this.onStatus("ready");
      }
      if (msg.type === "error" && msg.code === "missing_api_key") {
        this.closed = true;
        this.onStatus("unavailable");
      }
      this.onMessage(msg);
    };

    ws.onclose = () => {
      if (this.closed) return;
      const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)];
      if (this.attempt === 0) this.droppedAt = performance.now();
      this.attempt += 1;
      this.onStatus("reconnecting");
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }
}
