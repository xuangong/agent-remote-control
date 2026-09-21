import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { BROKER_MAX_FRAME_BYTES, createHostedRelay, isPreviewDomain, migrateLegacyNodeState, validateGatewayOrigin, type GatewayAuthOptions } from '@orchardworks/agent-remote-hosted';
import { openGatewayState } from './gateway-state.js';
import { InvalidHttpRequest, relaySocket, rejectUpgrade, webRequest, writeResponse } from './remote-host-broker.js';
import { previewSocket } from './preview-socket.js';

export interface GatewayRelayOptions extends GatewayAuthOptions {
  previewOrigin?: string;
  previewDomain?: string;
  maxTenants?: number;
  stateFile?: string;
  keyLifetimeMs?: number;
  servePage?(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}
export function createGatewayRelay(options: GatewayRelayOptions) {
  const auth = { origin: validateGatewayOrigin(options.origin), issuer: validateGatewayOrigin(options.issuer), secret: options.secret };
  if (Buffer.byteLength(auth.secret) < 32) throw new Error('Gateway signing secret must contain at least 32 bytes.');
  const protocols = new WeakMap<IncomingMessage, string | undefined>();
  const websockets = new WebSocketServer({ noServer: true, maxPayload: BROKER_MAX_FRAME_BYTES,
    handleProtocols(offered, request) { return protocols.has(request) ? protocols.get(request) ?? false : offered.values().next().value ?? false; } });
  let runtime: ReturnType<typeof createHostedRelay> | undefined;
  let storage: ReturnType<typeof openGatewayState> | undefined;
  const clientAddresses = new WeakMap<Request, string>();
  let previewOrigin = options.previewOrigin;
  function requestUrl(request: IncomingMessage) {
    const candidate = new URL(auth.origin).protocol + '//' + request.headers.host;
    const selected = isPreviewDomain(candidate, options.previewDomain, auth.origin) ? candidate : [auth.origin, previewOrigin].filter((value): value is string => !!value).find(value => new URL(value).host === request.headers.host);
    if (!selected) throw new InvalidHttpRequest();
    const url = new URL(request.url ?? '/', selected);
    if (url.origin !== selected) throw new InvalidHttpRequest();
    return url;
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (!runtime) throw new Error('Relay is starting.');
      const abort = new AbortController();
      response.once('close', () => abort.abort()); request.once('aborted', () => abort.abort());
      const forwarded = webRequest(request, requestUrl(request), true, abort.signal);
      clientAddresses.set(forwarded, request.socket.remoteAddress ?? 'unknown');
      const result = await runtime.fetch(forwarded);
      if (result) return writeResponse(response, result);
      response.setHeader('cache-control', 'no-store'); response.setHeader('referrer-policy', 'no-referrer'); response.setHeader('x-content-type-options', 'nosniff');
      if (await options.servePage?.(request, response)) return;
      response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'route_not_found', error: 'This route is unavailable. Check the URL and refresh the page.' }));
    })().catch(error => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(error instanceof InvalidHttpRequest ? 400 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ error: 'Relay request failed.' })); }
    });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      if (!runtime) return rejectUpgrade(socket, 503);
      const forwarded = webRequest(request, requestUrl(request), false);
      const preview = await runtime.preparePreviewUpgrade(forwarded);
      if (preview) {
        if (preview instanceof Response) return rejectUpgrade(socket, preview.status);
        protocols.set(request, preview.protocol);
        websockets.handleUpgrade(request, socket, head, client => preview.accept(previewSocket(client))); return;
      }
      const prepared = await runtime.prepareUpgrade(forwarded);
      if (!prepared || prepared instanceof Response) return rejectUpgrade(socket, prepared?.status ?? 404);
      websockets.handleUpgrade(request, socket, head, client => prepared.accept(relaySocket(client)));
    })().catch(error => rejectUpgrade(socket, error instanceof InvalidHttpRequest ? 400 : 503));
  });
  return {
    server,
    async listen(port: number, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      const address = server.address() as AddressInfo;
      if (new URL(auth.origin).port === '0') { const origin = new URL(auth.origin); origin.port = String(address.port); auth.origin = origin.origin; }
      if (previewOrigin && new URL(previewOrigin).port === '0') { const preview = new URL(previewOrigin); preview.port = String(address.port); previewOrigin = preview.origin; }
      try {
        if (options.stateFile) storage = openGatewayState(options.stateFile, auth.secret, JSON.stringify([auth.origin, auth.issuer]));
        const initial = storage ? migrateLegacyNodeState(storage.initial, auth) : undefined;
        runtime = createHostedRelay({ ...auth, previewOrigin, previewDomain: options.previewDomain, clientAddress: request => clientAddresses.get(request) ?? 'unknown', maxTenants: options.maxTenants, keyLifetimeMs: options.keyLifetimeMs,
          ...(storage ? { storage: { initial, commit: value => storage!.commit(value), close: () => storage!.close() } } : {}) });
      } catch (error) { storage?.close(); server.close(); throw error; }
      return { port: address.port, url: auth.origin };
    },
    async close() {
      await runtime?.close();
      for (const client of websockets.clients) client.terminate();
      await new Promise<void>(resolve => websockets.close(() => resolve()));
      storage?.close(); server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
