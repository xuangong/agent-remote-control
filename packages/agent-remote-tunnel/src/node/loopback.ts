import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import WebSocket from 'ws';
import type { HeaderList, TunnelPeerHandlers, TunnelWebSocketEndpoint } from '../types.js';

export interface LoopbackRegistration { target: string; pathMode: 'strip' | 'preserve'; status?: string }
export interface LoopbackTargetOptions { protectedPorts?: Iterable<number> }
export interface LoopbackTunnelOptions extends LoopbackTargetOptions {
  lookup(previewId: string): LoopbackRegistration | undefined;
  requestTimeoutMs?: number;
  maxResponseHeaderBytes?: number;
  maxWebSocketQueuedBytes?: number;
  maxWebSocketMessageBytes?: number;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export function canonicalizeLoopbackTarget(input: string, options: LoopbackTargetOptions = {}) {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  const url = new URL(candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Preview target must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Preview target must not contain userinfo.');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) throw new Error('Preview target must resolve to fixed loopback.');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Preview target has an invalid port.');
  if (new Set(options.protectedPorts).has(port)) throw new Error('Preview target uses a protected management port.');
  url.hostname = hostname === 'localhost' ? '127.0.0.1' : hostname === '::1' ? '[::1]' : '127.0.0.1';
  url.port = String(port);
  url.pathname = '/'; url.search = ''; url.hash = '';
  return url.origin;
}

function outgoingHeaders(headers: HeaderList): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error('Preview request contains an invalid header.');
    if (HOP_BY_HOP.has(name) || name === 'host') continue;
    const current = output[name];
    output[name] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }
  return output;
}

function responseHeaders(raw: string[]): HeaderList {
  const result: HeaderList = [];
  for (let index = 0; index < raw.length; index += 2) result.push([raw[index]!, raw[index + 1]!]);
  return result;
}

class NodeWebSocketEndpoint implements TunnelWebSocketEndpoint {
  private readonly listeners = new Set<(data: string | Uint8Array, binary: boolean) => void | Promise<void>>();
  private readonly pending: Array<{ data: string | Uint8Array; binary: boolean }> = [];
  private pendingBytes = 0;
  private delivery = Promise.resolve();
  constructor(private readonly socket: WebSocket, private readonly maxPendingBytes: number) {
    socket.on('message', (data, binary) => {
      const value = binary ? new Uint8Array(data as Buffer) : data.toString();
      const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
      if (this.pendingBytes + bytes > this.maxPendingBytes) { socket.close(1013, 'WebSocket consumer is too slow'); return; }
      if (this.listeners.size > 0) {
        this.pendingBytes += bytes;
        this.delivery = this.delivery.then(async () => { await Promise.all([...this.listeners].map(listener => listener(value, binary))); })
          .then(() => { this.pendingBytes -= bytes; }, () => { this.pendingBytes -= bytes; socket.close(1011, 'WebSocket forwarding failed'); });
        return;
      }
      this.pending.push({ data: value, binary }); this.pendingBytes += bytes;
    });
  }
  send(data: string | Uint8Array, binary = data instanceof Uint8Array) {
    return new Promise<void>((resolve, reject) => this.socket.send(data, { binary }, error => error ? reject(error) : resolve()));
  }
  onMessage(listener: (data: string | Uint8Array, binary: boolean) => void | Promise<void>) {
    this.listeners.add(listener);
    for (const message of this.pending.splice(0)) {
      const bytes = typeof message.data === 'string' ? Buffer.byteLength(message.data) : message.data.byteLength;
      this.delivery = this.delivery.then(() => listener(message.data, message.binary))
        .then(() => { this.pendingBytes -= bytes; }, () => { this.pendingBytes -= bytes; this.socket.close(1011, 'WebSocket forwarding failed'); });
    }
    return () => this.listeners.delete(listener);
  }
  close(code = 1000, reason = '') { this.socket.close(normalizeNodeCloseCode(code), reason.slice(0, 123)); }
  onClose(listener: (code: number, reason: string) => void) {
    const wrapped = (code: number, reason: Buffer) => listener(normalizeNodeCloseCode(code), reason.toString());
    this.socket.on('close', wrapped); return () => this.socket.off('close', wrapped);
  }
}

function normalizeNodeCloseCode(code: number) {
  return code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999) ? code : 1011;
}

export function createLoopbackTunnelHandlers(options: LoopbackTunnelOptions): TunnelPeerHandlers {
  function route(previewId: string) {
    const registration = options.lookup(previewId);
    if (!registration || (registration.status && registration.status !== 'active')) throw new Error('Preview registration is unavailable.');
    return new URL(canonicalizeLoopbackTarget(registration.target, options));
  }
  return {
    http(request, context) {
      return new Promise((resolve, reject) => {
        if (context.signal.aborted) { reject(new DOMException('Preview request was cancelled.', 'AbortError')); return; }
        const method = request.method.toUpperCase();
        if (!ALLOWED_METHODS.has(method)) { reject(new Error('Preview request method is not allowed.')); return; }
        if (!request.path.startsWith('/') || /[\r\n]/.test(request.path)) { reject(new Error('Preview request path is invalid.')); return; }
        const target = route(request.previewId);
        const transport = target.protocol === 'https:' ? https : http;
        let settled = false;
        const upstream = transport.request({
          protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
          method, path: request.path, headers: outgoingHeaders(request.headers),
          timeout: options.requestTimeoutMs ?? 30_000,
          maxHeaderSize: options.maxResponseHeaderBytes ?? 64 * 1024,
        }, response => {
          settled = true;
          const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
          resolve({ status: response.statusCode ?? 502, headers: responseHeaders(response.rawHeaders), body });
        });
        const abort = () => {
          const error = new DOMException('Preview request was cancelled.', 'AbortError');
          upstream.destroy(error);
          if (!settled) reject(error);
        };
        context.signal.addEventListener('abort', abort, { once: true });
        upstream.once('error', error => { if (!settled) reject(context.signal.aborted ? new DOMException('Preview request was cancelled.', 'AbortError') : error); });
        if (!request.body) { upstream.end(); return; }
        void (async () => {
          const reader = request.body!.getReader();
          try {
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              if (!upstream.write(item.value)) await once(upstream, 'drain');
            }
            upstream.end();
          } catch (error) { upstream.destroy(error as Error); }
          finally { reader.releaseLock(); }
        })();
      });
    },
    webSocket(request, context) {
      return new Promise((resolve, reject) => {
        if (context.signal.aborted) { reject(new DOMException('Preview WebSocket was cancelled.', 'AbortError')); return; }
        if (!request.path.startsWith('/') || /[\r\n]/.test(request.path)) { reject(new Error('Preview WebSocket path is invalid.')); return; }
        const target = route(request.previewId);
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        target.pathname = request.path.split('?')[0] || '/';
        target.search = request.path.includes('?') ? `?${request.path.split('?').slice(1).join('?')}` : '';
        const socket = new WebSocket(target, request.protocols, { headers: outgoingHeaders(request.headers) as IncomingHttpHeaders, handshakeTimeout: options.requestTimeoutMs ?? 15_000,
          followRedirects: false, maxPayload: options.maxWebSocketMessageBytes ?? 256 * 1024 - 512 });
        const abort = () => { socket.terminate(); reject(new DOMException('Preview WebSocket was cancelled.', 'AbortError')); };
        context.signal.addEventListener('abort', abort, { once: true });
        socket.once('open', () => { context.signal.removeEventListener('abort', abort); resolve({ protocol: socket.protocol || undefined, socket: new NodeWebSocketEndpoint(socket, options.maxWebSocketQueuedBytes ?? 1024 * 1024) }); });
        socket.once('error', reject);
      });
    },
  };
}
