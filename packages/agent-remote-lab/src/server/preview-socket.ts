import type { WebSocket, RawData } from 'ws';
import type { TunnelSocket } from '@agent-remote-controller/agent-remote-tunnel';

export function previewSocket(socket: WebSocket): TunnelSocket {
  socket.on('error', () => socket.terminate());
  return {
    get bufferedAmount() { return socket.bufferedAmount; },
    send: data => new Promise<void>((resolve, reject) => socket.send(data, { binary: data instanceof Uint8Array }, error => error ? reject(error) : resolve())),
    close: (code = 1000, reason = '') => socket.close(code === 1005 || code === 1006 ? 1011 : code, reason),
    onMessage(listener) {
      const receive = (data: RawData, binary: boolean) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        try { listener(binary ? new Uint8Array(bytes) : bytes.toString()); } catch { socket.close(1011, 'Preview message failed'); }
      };
      socket.on('message', receive); return () => { socket.off('message', receive); };
    },
    onClose(listener) { const close = (code: number, reason: Buffer) => listener(code, reason.toString()); socket.on('close', close); return () => { socket.off('close', close); }; },
  };
}
