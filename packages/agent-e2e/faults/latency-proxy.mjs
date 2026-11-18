// A fault-injecting proxy in front of a local instance, for measuring and stressing the browser under a bad network.
// It emulates, per direction: a round trip (every HTTP exchange and every WebSocket byte is delayed by half a round trip, so
// a request answered at once still takes one round trip), jitter, TCP-style loss (a lost chunk is retransmitted after a
// timeout that doubles, and holds back everything behind it; loss is drawn per chunk read from a socket, up to 64 KiB, not per
// packet, so a given rate is harsher than the same packet loss rate), a bandwidth cap, half-open sockets (a socket that stays open
// and silently swallows its bytes), and going offline. It rewrites the browser's origin to the target's so the instance
// accepts the requests, can close every open WebSocket to force the page to reconnect, and tees every WebSocket text message
// to `tap` as the receiving side gets it, so a run keeps a transcript of the wire. Conditions are seeded and can change while it runs (`setConditions`).
import http from 'node:http';
import net from 'node:net';
import { createFrameDecoder } from './ws-frames.mjs';
import { seededRandom } from './seeded-random.mjs';

const HEAD = Symbol('response head');
const MAX_RETRANSMITS = 6;

/**
 * An ordered, delayed pipe: `push(chunk)` calls `deliver(chunk)` later, in arrival order. A delay never lets a later chunk pass
 * an earlier one, as in TCP. `dead` pipes swallow what they receive.
 */
class Pipe {
  constructor(network, deliver) {
    this.network = network;
    this.deliver = deliver;
    this.queue = [];
    this.timer = undefined;
    this.freeAt = 0;
    this.lastAt = 0;
    this.dead = false;
  }

  push(chunk) {
    const { network } = this;
    if (this.dead) { network.counts.dropped += 1; return; }
    const now = Date.now();
    const bytes = typeof chunk === 'object' && chunk !== null && 'length' in chunk ? chunk.length : 0;
    const start = Math.max(now, this.freeAt);
    this.freeAt = start + (network.bandwidthBytesPerSec > 0 ? (bytes / network.bandwidthBytesPerSec) * 1000 : 0);
    let delay = Math.max(0, network.rttMs) / 2 + (network.jitterMs > 0 ? network.random.next() * network.jitterMs / 2 : 0);
    if (network.lossRate > 0 && bytes > 0) {
      const timeout = network.retransmitTimeoutMs ?? Math.max(200, network.rttMs * 2);
      for (let attempt = 0; attempt < MAX_RETRANSMITS && network.random.next() < network.lossRate; attempt += 1) {
        delay += timeout * 2 ** attempt;
        network.counts.retransmits += 1;
      }
    }
    const at = Math.max(this.lastAt, this.freeAt + delay);
    this.lastAt = at;
    this.queue.push({ at, chunk });
    this.schedule();
  }

  schedule() {
    if (this.timer !== undefined || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = Date.now();
      while (this.queue.length > 0 && this.queue[0].at <= now) {
        const { chunk } = this.queue.shift();
        if (!this.dead) this.deliver(chunk);
      }
      this.schedule();
    }, Math.max(0, this.queue[0].at - Date.now()));
  }

  stop() { clearTimeout(this.timer); this.timer = undefined; this.queue.length = 0; }
}

/**
 * Starts the proxy on `port` (0 for a free port) in front of `target` (an origin such as `http://localhost:61630`).
 * `rttMs` is the emulated round trip; `jitterMs`, `lossRate` (0 to 1), `bandwidthBytesPerSec` (0 for no cap) and `seed`
 * shape the rest; `retransmitTimeoutMs` replaces the default loss timeout of two round trips (at least 200 ms).
 * `tap({ t, connection, direction, text })` receives each WebSocket text message and `onSocket({ t, connection, event })`
 * receives `open` and `close`. `webSocketsCrossed` counts the upgrades that passed, so a
 * run can fail when its traffic did not go through the proxy.
 */
export async function startLatencyProxy({ target, rttMs = 0, port = 0, jitterMs = 0, lossRate = 0, bandwidthBytesPerSec = 0, seed = 1, retransmitTimeoutMs, tap, onSocket }) {
  const upstream = new URL(target);
  const agent = new http.Agent({ keepAlive: true });
  const sockets = new Set();
  const pairs = new Set();
  const counts = { requests: 0, webSocketsCrossed: 0, retransmits: 0, dropped: 0, messagesTapped: 0, refused: 0 };
  const network = { rttMs, jitterMs, lossRate, bandwidthBytesPerSec, random: seededRandom(seed), counts, offline: false, retransmitTimeoutMs };
  const pipes = new Set();
  const pipe = deliver => { const created = new Pipe(network, deliver); pipes.add(created); return created; };
  let publicOrigin;
  let connectionCount = 0;

  const toTarget = (headers, { upgrade = false } = {}) => {
    const rewritten = { ...headers, host: upstream.host };
    if (rewritten.origin) rewritten.origin = upstream.origin;
    if (rewritten.referer) rewritten.referer = rewritten.referer.replace(publicOrigin, upstream.origin);
    // A compressed message cannot be read by the tap, so the server is not offered compression.
    if (upgrade) delete rewritten['sec-websocket-extensions'];
    return rewritten;
  };
  const toBrowser = headers => {
    const rewritten = { ...headers };
    if (typeof rewritten.location === 'string') rewritten.location = rewritten.location.replace(upstream.origin, publicOrigin);
    return rewritten;
  };

  const server = http.createServer((request, response) => {
    if (network.offline) { counts.refused += 1; request.socket.destroy(); return; }
    counts.requests += 1;
    // The request leaves the proxy when its first bytes arrive after the delay, so it takes an upstream socket then: a socket taken
    // earlier idles through a loss timeout and the instance's server closes it (a reset the browser would never see on a real network).
    let outgoing;
    const start = () => {
      if (outgoing) return outgoing;
      outgoing = http.request({ host: upstream.hostname, port: upstream.port, path: request.url, method: request.method, headers: toTarget(request.headers), agent }, incoming => {
        const reply = pipe(chunk => {
          if (response.destroyed) return;
          if (chunk === HEAD) { response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, toBrowser(incoming.headers)); response.flushHeaders(); }
          else if (chunk === null) response.end();
          else response.write(chunk);
        });
        reply.push(HEAD);
        incoming.on('data', chunk => reply.push(chunk));
        incoming.on('end', () => reply.push(null));
        incoming.on('error', () => response.destroy());
      });
      outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      return outgoing;
    };
    const forward = pipe(chunk => { if (chunk === null) start().end(); else start().write(chunk); });
    response.on('close', () => { if (!response.writableFinished) outgoing?.destroy(); });
    request.on('data', chunk => forward.push(chunk));
    request.on('end', () => forward.push(null));
    request.on('error', () => outgoing?.destroy());
  });

  server.on('upgrade', (request, browserSocket, head) => {
    if (network.offline) { counts.refused += 1; browserSocket.destroy(); return; }
    counts.webSocketsCrossed += 1;
    const connection = ++connectionCount;
    const targetSocket = net.connect(Number(upstream.port), upstream.hostname);
    sockets.add(browserSocket);
    sockets.add(targetSocket);
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(toTarget(request.headers, { upgrade: true }))) for (const one of [].concat(value)) lines.push(`${name}: ${one}`);
    const emit = direction => text => { counts.messagesTapped += 1; tap?.({ t: Date.now(), connection, direction, text }); };
    const fromBrowser = createFrameDecoder({ onText: emit('browser->relay') });
    const fromTarget = createFrameDecoder({ onText: emit('relay->browser'), skipHttpHead: true });
    // The tap sees each message when the side that receives it does, so bytes the proxy swallows never appear in the transcript.
    const toUpstream = pipe(chunk => { fromBrowser.push(chunk); if (!targetSocket.destroyed) targetSocket.write(chunk); });
    const toClient = pipe(chunk => { fromTarget.push(chunk); if (!browserSocket.destroyed) browserSocket.write(chunk); });
    const pair = { connection, pipes: [toUpstream, toClient], toUpstream, toClient };
    pairs.add(pair);
    onSocket?.({ t: Date.now(), connection, event: 'open' });
    const relayBrowser = chunk => toUpstream.push(chunk);
    const relayTarget = chunk => toClient.push(chunk);
    targetSocket.on('connect', () => {
      targetSocket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) relayBrowser(head);
      browserSocket.on('data', relayBrowser);
      targetSocket.on('data', relayTarget);
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      sockets.delete(browserSocket); sockets.delete(targetSocket); pairs.delete(pair);
      toUpstream.stop(); toClient.stop(); pipes.delete(toUpstream); pipes.delete(toClient);
      browserSocket.destroy(); targetSocket.destroy();
      onSocket?.({ t: Date.now(), connection, event: 'close' });
    };
    browserSocket.on('error', end); targetSocket.on('error', end);
    browserSocket.on('close', end); targetSocket.on('close', end);
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
  publicOrigin = `http://localhost:${server.address().port}`;
  const closeAll = () => { for (const socket of [...sockets]) socket.destroy(); };
  return {
    origin: publicOrigin,
    counts,
    /** Changes the network while the proxy runs; only the named conditions change. */
    setConditions(next) {
      for (const key of ['rttMs', 'jitterMs', 'lossRate', 'bandwidthBytesPerSec']) if (next[key] !== undefined) network[key] = next[key];
    },
    conditions: () => ({ rttMs: network.rttMs, jitterMs: network.jitterMs, lossRate: network.lossRate, bandwidthBytesPerSec: network.bandwidthBytesPerSec, offline: network.offline }),
    /** Closes every open WebSocket, so the page reconnects through the proxy. */
    closeWebSockets: closeAll,
    /**
     * Makes every WebSocket open now half-open: the sockets stay open on both sides and their bytes are swallowed, in both
     * directions or only `toBrowser` or `toTarget`. Sockets opened later work. Returns how many sockets it affected.
     */
    halfOpenWebSockets({ direction = 'both' } = {}) {
      for (const pair of pairs) {
        if (direction !== 'toTarget') pair.toClient.dead = true;
        if (direction !== 'toBrowser') pair.toUpstream.dead = true;
      }
      return pairs.size;
    },
    /** While offline the proxy drops every open socket and refuses new connections and requests. */
    setOffline(offline) { network.offline = offline; if (offline) closeAll(); },
    openWebSockets: () => pairs.size,
    async close() {
      closeAll();
      for (const one of pipes) one.stop();
      agent.destroy();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
