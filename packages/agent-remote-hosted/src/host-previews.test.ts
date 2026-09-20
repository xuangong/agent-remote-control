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


test('keeps an offline removal pending through expired snapshots until the Controller confirms unregister', async () => {
  const removed: string[] = [];
  let online = false;
  const previews = createHostPreviews({ async save(_state, publish) { publish(); }, async remove(_host, id) {
    if (!online) throw new Error('Offline');
    removed.push(id);
  } });
  try {
    const expired = snapshot(2);
    expired.registrations[0]!.status = 'expired';
    await previews.update('host', expired);
    previews.disconnect('host');
    await previews.unregister('host', 'preview-id');
    online = true;
    await previews.update('host', expired);
    expect(removed).toEqual(['preview-id']);
    expect(previews.list('host').registrations[0]?.pendingUnregister).toBe(true);
    await previews.update('host', snapshot(3));
    expect(previews.lookup('host', 'preview-id')).toBeUndefined();
    const confirmed = snapshot(4);
    confirmed.registrations[0]!.status = 'unregistered';
    await previews.update('host', confirmed);
    expect(previews.list('host').registrations[0]?.pendingUnregister).toBeUndefined();
  } finally { previews.close(); }
});

test('reserves a name by Host and local origin across removal, pruning and Relay restart', async () => {
  const options = { async save(_state: unknown, publish: () => void) { publish(); }, async remove() {} };
  let previews = createHostPreviews(options);
  const next = (revision: number, id: string, target = 'http://127.0.0.1:5173'): PreviewSnapshot => {
    const value = snapshot(revision); value.registrations[0] = { ...value.registrations[0]!, id, target }; return value;
  };
  try {
    await previews.update('host', next(1, 'first'));
    const deadline = previews.list('host').registrations[0]!.expiresAt;
    await previews.pinName('host', 'first', true);
    expect(previews.list('host').registrations[0]).toMatchObject({ tunnelNamePinned: true, expiresAt: deadline });
    await previews.unregister('host', 'first');
    await previews.update('host', { epoch: 'controller-a', revision: 2, registrations: [] });
    const saved = previews.snapshot(); previews.close();
    previews = createHostPreviews({ ...options, initial: saved });
    await previews.update('host', next(3, 'second', 'http://localhost:5173'));
    expect(previews.nameId('host', 'second')).toBe('first');
    expect(previews.lookup('host', 'first')).toBeUndefined();
    await previews.update('other-host', next(1, 'other', 'http://localhost:5173'));
    expect(previews.nameId('other-host', 'other')).toBe('other');
    await previews.update('host', next(4, 'other-port', 'http://127.0.0.1:5174'));
    expect(previews.nameId('host', 'other-port')).toBe('other-port');
    await previews.update('host', next(5, 'third'));
    expect(previews.nameId('host', 'third')).toBe('first');
    await previews.pinName('host', 'third', false);
    expect(previews.nameId('host', 'third')).toBe('first');
    expect(previews.list('host').registrations[0]!.tunnelNamePinned).toBe(false);
    await previews.update('host', next(6, 'fourth'));
    expect(previews.nameId('host', 'fourth')).toBe('fourth');
  } finally { previews.close(); }
});

test('keeps pin persistence atomic and never assigns a reserved name to two active registrations', async () => {
  let fail = false;
  const previews = createHostPreviews({ async save(_state, publish) { if (fail) throw new Error('Storage unavailable'); publish(); }, async remove() {} });
  try {
    await previews.update('host', snapshot(1)); fail = true;
    await expect(previews.pinName('host', 'preview-id', true)).rejects.toThrow('Storage unavailable');
    expect(previews.list('host').registrations[0]!.tunnelNamePinned).toBe(false);
    fail = false; await previews.pinName('host', 'preview-id', true);
    const next = snapshot(2); next.registrations.push({ ...next.registrations[0]!, id: 'second', pathMode: 'preserve' });
    await previews.update('host', next);
    expect(previews.nameId('host', 'second')).toBe('second');
    await expect(previews.pinName('host', 'second', true)).rejects.toThrow('already has a pinned');
  } finally { previews.close(); }
});
