import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { stubBrowserPage } from '../testing/page.js';
import type { WebSocketLike } from './http-websocket-transport.js';
import type { ChannelLink } from './relay-link.js';
import { SessionChannelPool } from './session-channel-transport.js';

stubBrowserPage();

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  send(): void {}
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  ready(): void { this.onmessage?.({ data: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ready' }) }); }
  drop(): void { this.readyState = 3; this.onclose?.({}); }
}

function pool() {
  const sockets: FakeSocket[] = [];
  const channels = new SessionChannelPool({
    stateRetryMs: 10,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    connectDirect: () => { throw new Error('No direct connection in this test.'); },
    observe: () => {}, diagnostic: () => {},
  });
  const links: ChannelLink[] = [];
  const stop = channels.subscribeRelayLink(link => links.push(link));
  return { channels, sockets, links, stop };
}

describe('the link of the activity channel', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is unknown until the activity channel is ready, then up', () => {
    const { channels, sockets, links } = pool();
    channels.watchStates();
    expect(channels.relayLink()).toBe('unknown');
    sockets[0]!.open();
    expect(channels.relayLink()).toBe('unknown');
    sockets[0]!.ready();
    expect(channels.relayLink()).toBe('up');
    expect(links).toEqual(['up']);
    channels.dispose();
  });

  it('goes down when the socket closes and up when the reopened channel is ready', () => {
    const { channels, sockets, links } = pool();
    channels.watchStates();
    sockets[0]!.open(); sockets[0]!.ready();
    sockets[0]!.drop();
    expect(channels.relayLink()).toBe('down');
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(channels.relayLink()).toBe('down');
    sockets[1]!.ready();
    expect(links).toEqual(['up', 'down', 'up']);
    channels.dispose();
  });

  it('does not call a first open that fails at once down, but does call one that misses its open deadline down', () => {
    const { channels, sockets, links } = pool();
    channels.watchStates();
    sockets[0]!.drop();
    expect(channels.relayLink()).toBe('unknown');
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(20_000);
    expect(channels.relayLink()).toBe('down');
    expect(links).toEqual(['down']);
    channels.dispose();
  });

  it('stops telling a listener after it unsubscribes, and after dispose', () => {
    const { channels, sockets, links, stop } = pool();
    const later: ChannelLink[] = [];
    channels.subscribeRelayLink(link => later.push(link));
    channels.watchStates();
    sockets[0]!.open(); sockets[0]!.ready();
    stop();
    sockets[0]!.drop();
    expect(links).toEqual(['up']);
    expect(later).toEqual(['up', 'down']);
    channels.dispose();
    vi.advanceTimersByTime(10);
    expect(later).toEqual(['up', 'down']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes no claim once nobody watches the activity channel, so a stale down clears', () => {
    const { channels, sockets, links } = pool();
    const stop = channels.watchStates();
    sockets[0]!.open(); sockets[0]!.ready(); sockets[0]!.drop();
    stop();
    expect(channels.relayLink()).toBe('unknown');
    expect(links).toEqual(['up', 'down', 'unknown']);
    channels.dispose();
  });

  it('reopens a lost channel at once when asked, without waiting for its backoff', () => {
    const { channels, sockets } = pool();
    channels.watchStates();
    sockets[0]!.open(); sockets[0]!.ready(); sockets[0]!.drop();
    expect(sockets).toHaveLength(1);
    channels.reopenRelayLink();
    expect(sockets).toHaveLength(2);
    channels.reopenRelayLink();
    expect(sockets).toHaveLength(2);
    channels.dispose();
  });
});
