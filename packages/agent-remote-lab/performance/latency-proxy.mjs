// A delaying proxy in front of a local instance, for measuring the browser at a given round trip (see README.md).
// Every HTTP exchange and every WebSocket byte is delayed by half a round trip in each direction, so a request answered at
// once still takes one round trip. The proxy rewrites the browser's origin to the target's, so the instance accepts the
// requests, and can close every open WebSocket to force the page to reconnect.
import http from 'node:http';
import net from 'node:net';

const HEAD = Symbol('response head');

/** Calls `deliver(chunk)` for each chunk `delayMs` after it arrived, in arrival order. */
function delayedPipe(delayMs, deliver) {
  return chunk => { if (delayMs <= 0) deliver(chunk); else setTimeout(() => deliver(chunk), delayMs); };
}

/**
 * Starts the proxy on `port` (0 for a free port) in front of `target` (an origin such as `http://localhost:61630`).
 * `rttMs` is the emulated round trip. `webSocketsCrossed` counts the upgrades that passed, so a run can fail when its
 * traffic did not go through the proxy.
 */
export async function startLatencyProxy({ target, rttMs, port = 0 }) {
  const upstream = new URL(target);
  const half = Math.max(0, rttMs) / 2;
  const agent = new http.Agent({ keepAlive: true });
  const sockets = new Set();
  const counts = { requests: 0, webSocketsCrossed: 0 };
  let publicOrigin;

  const toTarget = headers => {
    const rewritten = { ...headers, host: upstream.host };
    if (rewritten.origin) rewritten.origin = upstream.origin;
    if (rewritten.referer) rewritten.referer = rewritten.referer.replace(publicOrigin, upstream.origin);
    return rewritten;
  };
  const toBrowser = headers => {
    const rewritten = { ...headers };
    if (typeof rewritten.location === 'string') rewritten.location = rewritten.location.replace(upstream.origin, publicOrigin);
    return rewritten;
  };

  const server = http.createServer((request, response) => {
    counts.requests += 1;
    const forward = delayedPipe(half, chunk => { if (chunk === null) outgoing.end(); else outgoing.write(chunk); });
    const outgoing = http.request({ host: upstream.hostname, port: upstream.port, path: request.url, method: request.method, headers: toTarget(request.headers), agent }, incoming => {
      const reply = delayedPipe(half, chunk => {
        if (response.destroyed) return;
        if (chunk === HEAD) { response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, toBrowser(incoming.headers)); response.flushHeaders(); }
        else if (chunk === null) response.end();
        else response.write(chunk);
      });
      reply(HEAD);
      incoming.on('data', reply);
      incoming.on('end', () => reply(null));
      incoming.on('error', () => response.destroy());
    });
    outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => { if (!response.writableFinished) outgoing.destroy(); });
    request.on('data', forward);
    request.on('end', () => forward(null));
    request.on('error', () => outgoing.destroy());
  });

  server.on('upgrade', (request, browserSocket, head) => {
    counts.webSocketsCrossed += 1;
    const targetSocket = net.connect(Number(upstream.port), upstream.hostname);
    sockets.add(browserSocket);
    sockets.add(targetSocket);
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(toTarget(request.headers))) for (const one of [].concat(value)) lines.push(`${name}: ${one}`);
    const toUpstream = delayedPipe(half, chunk => { if (!targetSocket.destroyed) targetSocket.write(chunk); });
    const toClient = delayedPipe(half, chunk => { if (!browserSocket.destroyed) browserSocket.write(chunk); });
    targetSocket.on('connect', () => {
      targetSocket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) toUpstream(head);
      browserSocket.on('data', toUpstream);
      targetSocket.on('data', toClient);
    });
    const end = () => { sockets.delete(browserSocket); sockets.delete(targetSocket); browserSocket.destroy(); targetSocket.destroy(); };
    browserSocket.on('error', end); targetSocket.on('error', end);
    browserSocket.on('close', end); targetSocket.on('close', end);
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
  publicOrigin = `http://localhost:${server.address().port}`;
  return {
    origin: publicOrigin,
    counts,
    /** Closes every open WebSocket, so the page reconnects through the proxy. */
    closeWebSockets() { for (const socket of [...sockets]) socket.destroy(); },
    async close() {
      for (const socket of [...sockets]) socket.destroy();
      agent.destroy();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
