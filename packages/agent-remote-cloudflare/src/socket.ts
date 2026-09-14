import { BROKER_MAX_FRAME_BYTES, RELAY_SOCKET_OPEN, type RelaySocket } from '@borgee/agent-remote-hosted';

/** Workers has no public egress queue metric; native buffering cannot be measured here. */
export class WorkerRelaySocket implements RelaySocket {
  readonly bufferedAmount = undefined;
  private readonly messages = new Set<(data: string, binary: boolean) => void | Promise<void>>();
  constructor(private readonly socket: WebSocket, private readonly context: Pick<DurableObjectState, 'waitUntil'>) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', event => {
      const data = event.data;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data instanceof ArrayBuffer ? data.byteLength : Infinity;
      if (bytes > BROKER_MAX_FRAME_BYTES) { this.close(1009, 'Relay frame is too large'); return; }
      const binary = typeof data !== 'string';
      for (const listener of this.messages) {
        try {
          const pending = listener(binary ? '' : data, binary);
          if (pending) this.context.waitUntil(Promise.resolve(pending).catch(() => this.close(1011, 'Relay frame processing failed')));
        } catch { this.close(1011, 'Relay frame processing failed'); }
      }
    });
  }
  get readyState() { return this.socket.readyState; }
  send(data: string) {
    if (new TextEncoder().encode(data).byteLength > BROKER_MAX_FRAME_BYTES) { this.close(1009, 'Relay frame is too large'); return; }
    if (this.socket.readyState !== RELAY_SOCKET_OPEN) throw new Error('Relay socket is closed.');
    this.socket.send(data);
  }
  close(code = 1000, reason = '') {
    if (this.socket.readyState < 2) this.socket.close(code, reason);
  }
  onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onClose(listener: () => void) { this.socket.addEventListener('close', listener); return () => this.socket.removeEventListener('close', listener); }
  onError(listener: () => void) {
    const handler = () => { try { listener(); } finally { this.close(1011, 'Relay socket failed'); } };
    this.socket.addEventListener('error', handler); return () => this.socket.removeEventListener('error', handler);
  }
}
