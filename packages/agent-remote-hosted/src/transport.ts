export const RELAY_SOCKET_OPEN = 1;
export const BROKER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const BROKER_MAX_BODY_BYTES = 64 * 1024;

/** Runtime adapters deliver validated frames and own their native socket lifecycle. */
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number | undefined;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string, binary: boolean) => void | Promise<void>): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: () => void): () => void;
}

export interface BrokerRequestContext {
  principalSubject?(): string | undefined;
  authorize?(): boolean | Promise<boolean>;
  validateMutation?(): { status: 'allowed' } | { status: 'rejected'; httpStatus: number; code: string; message: string };
  connectionExpiresAt?(): number | undefined;
  connectionExpiryCode?(): number;
  serverUrl?: string;
}

export interface BrokerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const defaultBrokerScheduler: BrokerScheduler = {
  setTimeout(callback, delayMs) {
    const timer = globalThis.setTimeout(callback, delayMs);
    (timer as unknown as { unref?(): void }).unref?.();
    return timer;
  },
  clearTimeout(timer) { if (timer !== undefined) globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>); },
};
