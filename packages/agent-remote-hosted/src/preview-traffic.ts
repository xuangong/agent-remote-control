import type { TunnelSocket } from '@orchardworks/agent-remote-tunnel';

/** Observe forwarded bytes without prefetching or changing stream backpressure. */
export function previewTrafficBody(body: ReadableStream<Uint8Array> | undefined, activity: () => void) {
  if (!body) return undefined;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { reader.releaseLock(); controller.close(); }
        else { if (part.value.byteLength) activity(); controller.enqueue(part.value); }
      } catch (error) { reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
}

export function previewTrafficSocket(socket: TunnelSocket, activity: () => void): TunnelSocket {
  return {
    get bufferedAmount() { return socket.bufferedAmount; },
    async send(data) { await socket.send(data); activity(); },
    onMessage(listener) { return socket.onMessage(data => { activity(); listener(data); }); },
    onClose: listener => socket.onClose(listener),
    close: (code, reason) => socket.close(code, reason),
  };
}
