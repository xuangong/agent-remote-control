import type { TunnelData, TunnelSocket } from '@agent-remote-controller/agent-remote-tunnel';

/** Application WS has no Workers drain signal, so a lifetime byte budget bounds native egress. */
export class WorkerPreviewSocket implements TunnelSocket {
  private sentBytes = 0;
  private readonly listeners = new Set<(data: TunnelData) => void>();
  constructor(private readonly socket: WebSocket, private readonly maxSendBytes = 16 * 1024 * 1024) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', event => {
      const data = typeof event.data === 'string' ? event.data : event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : undefined;
      if (data === undefined || (typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength) > 256 * 1024) { this.close(1009, 'Preview frame is too large'); return; }
      for (const listener of this.listeners) { try { listener(data); } catch { this.close(1011, 'Preview message failed'); } }
    });
    socket.addEventListener('error', () => this.close(1011, 'Preview socket failed'));
  }
  send(data: TunnelData) {
    this.sentBytes += typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (this.sentBytes > this.maxSendBytes) { this.close(1013, 'Preview send budget reached; reconnect'); throw new Error('Preview send budget exceeded.'); }
    if (this.socket.readyState !== 1) throw new Error('Preview socket is closed.');
    this.socket.send(data);
  }
  close(code = 1000, reason = '') { if (this.socket.readyState < 2) this.socket.close([1005, 1006].includes(code) ? 1011 : code, reason); }
  onMessage(listener: (data: TunnelData) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: (code: number, reason: string) => void) { const close = (event: CloseEvent) => listener(event.code, event.reason); this.socket.addEventListener('close', close); return () => this.socket.removeEventListener('close', close); }
}
