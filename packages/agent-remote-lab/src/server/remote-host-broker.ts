import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentRemoteRequestAccessPolicy, AgentRemoteHttpMutationPolicy } from '@agent-remote-controller/agent-remote-relay';
import { BROKER_MAX_FRAME_BYTES, createHostBroker, type BrokerRequestContext, type HostBrokerOptions, type RelaySocket } from '@agent-remote-controller/agent-remote-hosted';
import { createLocalLabMutationPolicy } from './local-authorizer.js';

export type { RemoteHostBrokerState } from '@agent-remote-controller/agent-remote-hosted';
export interface RemoteHostBrokerOptions extends HostBrokerOptions {
  principalSubject?(request: IncomingMessage): string | undefined;
  accessPolicy?: AgentRemoteRequestAccessPolicy;
  mutationPolicy?: AgentRemoteHttpMutationPolicy;
  connectionExpiresAt?(request: IncomingMessage): number | undefined;
  connectionExpiryCode?(request: IncomingMessage): number;
}

export function createRemoteHostBroker(options: RemoteHostBrokerOptions) {
  const origin = new URL(options.origin).origin;
  const mutationPolicy = options.mutationPolicy ?? createLocalLabMutationPolicy(origin);
  const broker = createHostBroker(options);
  const websockets = new WebSocketServer({ noServer: true, maxPayload: BROKER_MAX_FRAME_BYTES });
  const context = (request: IncomingMessage): BrokerRequestContext => {
    const address = request.socket.localAddress?.includes(':') ? `[${request.socket.localAddress}]` : request.socket.localAddress;
    return {
      principalSubject: () => options.principalSubject?.(request),
      authorize: async () => options.accessPolicy ? await options.accessPolicy.authorize(request) === true
        : local(request, origin),
      validateMutation: () => mutationPolicy.validate(request),
      ...(options.connectionExpiresAt ? { connectionExpiresAt: () => options.connectionExpiresAt!(request) } : {}),
      ...(options.connectionExpiryCode ? { connectionExpiryCode: () => options.connectionExpiryCode!(request) } : {}),
      serverUrl: `http://${address}:${request.socket.localPort}`,
    };
  };
  return {
    ...broker,
    install(server: Server) {
      const requests = server.listeners('request'); const upgrades = server.listeners('upgrade');
      server.removeAllListeners('request'); server.removeAllListeners('upgrade');
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!broker.handlesRequest(url)) {
          for (const handler of requests) handler.call(server, request, response); return;
        }
        void Promise.resolve().then(() => broker.handleRequest(webRequest(request, url), context(request))).then(result => {
          if (result) return writeResponse(response, result);
        }).catch(error => {
          if (response.destroyed || response.writableEnded) return;
          const invalidRequest = error instanceof InvalidHttpRequest;
          response.writeHead(invalidRequest ? 400 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ code: invalidRequest ? 'invalid_request' : 'host_operation_failed', error: error instanceof Error ? error.message : 'Remote Host operation failed.' }));
        });
      });
      server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!broker.handlesUpgrade(url)) {
          for (const handler of upgrades) handler.call(server, request, socket, head); return;
        }
        void Promise.resolve().then(() => broker.prepareUpgrade(webRequest(request, url, false), context(request))).then(prepared => {
          if (!prepared || prepared instanceof Response) return rejectUpgrade(socket, prepared?.status ?? 404);
          websockets.handleUpgrade(request, socket, head, client => prepared.accept(relaySocket(client)));
        }).catch(error => rejectUpgrade(socket, error instanceof InvalidHttpRequest ? 400 : 503));
      });
    },
    async close() {
      broker.close();
      for (const client of websockets.clients) client.terminate();
      await broker.settled();
      await new Promise<void>(resolve => websockets.close(() => resolve()));
    },
  };
}

function local(request: IncomingMessage, origin: string): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') && (!request.headers.origin || request.headers.origin === origin);
}
export class InvalidHttpRequest extends Error {
  constructor() { super('The HTTP request is unsupported.'); }
}
export function webRequest(request: IncomingMessage, url: URL, body = true, signal?: AbortSignal): Request {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const method = request.method ?? 'GET';
    const init: RequestInit & { duplex?: 'half' } = { method, headers, signal };
    if (body && method !== 'GET' && method !== 'HEAD') {
      init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
      init.duplex = 'half';
    }
    return new Request(url, init);
  } catch { throw new InvalidHttpRequest(); }
}
export async function writeResponse(response: ServerResponse, result: Response) {
  if (response.destroyed || response.writableEnded) return;
  const headers: Record<string, string | string[]> = {};
  result.headers.forEach((value, key) => { if (key !== 'set-cookie') headers[key] = value; });
  const cookies = result.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies;
  response.writeHead(result.status, headers);
  if (!result.body) { response.end(); return; }
  response.flushHeaders();
  await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
}
export function relaySocket(socket: WebSocket): RelaySocket {
  socket.on('error', () => undefined);
  return {
    get readyState() { return socket.readyState; },
    get bufferedAmount() { return socket.bufferedAmount; },
    send: data => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage(listener) {
      const receive = (data: import('ws').RawData, binary: boolean) => {
        try { void Promise.resolve(listener(data.toString(), binary)).catch(() => socket.close(1011, 'Socket message failed')); }
        catch { socket.close(1011, 'Socket message failed'); }
      };
      socket.on('message', receive); return () => { socket.off('message', receive); };
    },
    onClose(listener) { socket.on('close', listener); return () => { socket.off('close', listener); }; },
    onError(listener) { socket.on('error', listener); return () => { socket.off('error', listener); }; },
  };
}
export function rejectUpgrade(socket: Duplex, status: number) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
