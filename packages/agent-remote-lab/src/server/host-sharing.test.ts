import { expect, it } from 'vitest';
import { HostSharing } from './host-sharing.js';

it('reserves cumulative per-user quotas and preserves them through revoke, regrant and restart', () => {
  const sharing = new HostSharing(undefined, () => {});
  sharing.set('host', 'bob', 'Bob', 1);
  const first = sharing.reserve('host', 'bob', 'codex', 'r1', 'body');
  expect(first.fresh).toBe(true);
  expect(sharing.reserve('host', 'bob', 'codex', 'r1', 'body').fresh).toBe(false);
  expect(() => sharing.reserve('host', 'bob', 'codex', 'r2', 'body')).toThrow(/quota/i);
  sharing.complete(first.key, 'agent');
  sharing.revoke('host', 'bob');
  expect(sharing.allowed('host', 'bob')).toBe(false);
  sharing.set('host', 'bob', 'Bob', 1);
  const restored = new HostSharing(sharing.snapshot(), () => {});
  expect(restored.quota('host', 'bob')).toEqual({ limit: 1, used: 1 });
  expect(restored.reserve('host', 'bob', 'codex', 'r1', 'body')).toMatchObject({ fresh: false, agentId: 'agent' });
  restored.set('host', 'bob', 'Bob', 2);
  expect(restored.reserve('host', 'bob', 'codex', 'r2', 'body').fresh).toBe(true);
});

it('keeps uncertain reservations, detects request conflicts and isolates user request IDs', () => {
  const sharing = new HostSharing(undefined, () => {});
  sharing.set('h', 'bob', 'Bob', 2); sharing.set('h', 'eve', 'Eve', 2);
  const bob = sharing.reserve('h', 'bob', 'codex', 'same', 'body');
  const eve = sharing.reserve('h', 'eve', 'codex', 'same', 'body');
  expect(bob.nativeRequestId).not.toBe(eve.nativeRequestId);
  expect(() => sharing.reserve('h', 'bob', 'codex', 'same', 'changed')).toThrow(/different/i);
  const restored = new HostSharing(sharing.snapshot(), () => {});
  expect(restored.reserve('h', 'bob', 'codex', 'same', 'body')).toMatchObject({ fresh: false });
  expect(restored.quota('h', 'bob').used).toBe(1);
  restored.release(bob.key);
  expect(restored.quota('h', 'bob').used).toBe(0);
});
