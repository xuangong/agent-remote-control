export interface LatencyProxy {
  origin: string;
  counts: { requests: number; webSocketsCrossed: number };
  closeWebSockets(): void;
  close(): Promise<void>;
}
export function startLatencyProxy(options: { target: string; rttMs: number; port?: number }): Promise<LatencyProxy>;
