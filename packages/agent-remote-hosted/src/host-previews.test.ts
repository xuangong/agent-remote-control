import { describe, expect, test } from 'vitest';
import type { PreviewSnapshot } from '@agent-remote-controller/agent-remote-tunnel';
import { createHostPreviews } from './host-previews.js';
import type { TunnelSocket } from '@agent-remote-controller/agent-remote-tunnel';

function snapshot(revision: number): PreviewSnapshot {
  return { epoch: 'controller-a', revision, registrations: [{
    id: 'preview-id', target: 'http://127.0.0.1:5173', status: 'active', createdAt: 1, expiresAt: Date.now() + 60_000,
    revision, pathMode: 'strip', sources: [{ sessionId: 'session', itemId: 'item' }],
  }] };
}

describe('Host previews', () => {
  test('does not let an older concurrent snapshot replace a newer revision', async () => {
    const previews = createHostPreviews({
      async save(_state, publish) { await Promise.resolve(); publish(); },
      async remove() {},
    });
    await Promise.all([previews.update('host', snapshot(2)), previews.update('host', snapshot(1))]);
    expect(previews.list('host').revision).toBe(2);
    previews.close();
  });

  test('reconciles an unchanged snapshot after the Controller reconnects', async () => {
    const previews = createHostPreviews({ async save(_state, publish) { publish(); }, async remove() {} });
    const socket = (): TunnelSocket => ({
      send() {}, close() {}, onMessage() { return () => {}; }, onClose() { return () => {}; },
    });
    previews.attach('host', socket());
    await previews.update('host', snapshot(1));
    expect(previews.list('host').registrations[0]).toMatchObject({ availability: 'online' });
    previews.disconnect('host');
    previews.attach('host', socket());
    expect(previews.list('host').registrations[0]).toMatchObject({ availability: 'controller_offline' });
    await previews.update('host', snapshot(1));
    expect(previews.list('host').registrations[0]).toMatchObject({ availability: 'online' });
    previews.close();
  });

  test('does not apply a queued snapshot from an invalidated Controller generation', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let saves = 0;
    const previews = createHostPreviews({ async save(_state, publish) { if (++saves === 1) await held; publish(); }, async remove() {} });
    const first = previews.update('host', snapshot(1));
    const stale = previews.update('host', snapshot(2));
    previews.invalidate('host'); release();
    await Promise.all([first, stale]);
    expect(previews.list('host').revision).toBe(0);
    previews.close();
  });
});
