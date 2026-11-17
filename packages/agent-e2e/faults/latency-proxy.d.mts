export interface TappedMessage { t: number; connection: number; direction: 'browser->relay' | 'relay->browser'; text: string }
export interface SocketEvent { t: number; connection: number; event: 'open' | 'close' }
export interface NetworkConditions { rttMs: number; jitterMs: number; lossRate: number; bandwidthBytesPerSec: number }
export interface LatencyProxy {
  origin: string;
  counts: { requests: number; webSocketsCrossed: number; retransmits: number; dropped: number; messagesTapped: number; refused: number };
  setConditions(next: Partial<NetworkConditions>): void;
  conditions(): NetworkConditions & { offline: boolean };
  closeWebSockets(): void;
  halfOpenWebSockets(options?: { direction?: 'both' | 'toBrowser' | 'toTarget' }): number;
  setOffline(offline: boolean): void;
  openWebSockets(): number;
  close(): Promise<void>;
}
export function startLatencyProxy(options: {
  target: string; rttMs?: number; port?: number; jitterMs?: number; lossRate?: number; bandwidthBytesPerSec?: number; seed?: number; retransmitTimeoutMs?: number;
  tap?(message: TappedMessage): void; onSocket?(event: SocketEvent): void;
}): Promise<LatencyProxy>;
