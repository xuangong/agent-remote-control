import { memoryHttp, type MemoryHttp } from '@orchardworks/agent-session-runtime/testing';

import { createProtocolValidationServer, type ProtocolValidationServerOptions } from '../protocol-validation-server.js';
import { createRecordedValidationServer } from '../recorded.js';
import type { RecordedLabProviderOptions } from '../recorded.js';

/**
 * Test support: the lab Relay without a listener. Each function returns the server it wraps and `net`, the in-memory
 * `fetch` and WebSocket clients that reach it (see `memoryHttp`). The Relay's own loopback connection for a channel
 * subscription goes through the same memory network, so nothing opens a port. `close()` also ends the open connections.
 */
export type MemoryRelay<T> = T & { net: MemoryHttp };

export function memoryProtocolRelay(options: ProtocolValidationServerOptions): MemoryRelay<ReturnType<typeof createProtocolValidationServer>> {
  let net!: MemoryHttp;
  const server = createProtocolValidationServer({ ...options, connectLocalSession: (url, init) => net.webSocket(url, init) });
  net = memoryHttp(server.http.server);
  return { ...server, net, async close() { net.close(); await server.close(); } };
}

export function memoryRecordedRelay(options: RecordedLabProviderOptions = {}): MemoryRelay<ReturnType<typeof createRecordedValidationServer>> {
  let net!: MemoryHttp;
  const server = createRecordedValidationServer(options, { connectLocalSession: (url, init) => net.webSocket(url, init) });
  net = memoryHttp(server.http.server);
  return { ...server, net, async close() { net.close(); await server.close(); } };
}
