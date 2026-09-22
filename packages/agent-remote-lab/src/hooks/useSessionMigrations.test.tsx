import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionMigration } from '@orchardworks/agent-remote-protocol';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { render } from '../test/setup.js';
import { useSessionMigrations } from './useSessionMigrations.js';
const from = { hostId: 'host', providerId: 'codex', nativeSessionId: 'old', agentId: 'old-agent', title: 'Conversation' };
const to = { ...from, nativeSessionId: 'new', agentId: 'new-agent' };
const migration: SessionMigration = { id: 'edit', from, to, createdAt: 1 };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });
async function fixture(options: { fail?: boolean; block?: boolean; side?: boolean } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ migrations: [] }) }));
  let receive!: (value: SessionMigration) => void;
  let select!: (value: typeof from) => void;
  let blocked = options.block ?? false;
  const apply = vi.fn();
  const follow = vi.fn(async (target: typeof from) => { if (options.fail) throw new Error('Disconnected'); select(target); return true; });
  const transport = { onSessionMigration: (listener: typeof receive) => { receive = listener; return () => {}; } } as RemoteAgentTransport;
  function Fixture() {
    const [current, setCurrent] = useState(from); select = setCurrent;
    const { notice } = useSessionMigrations({ baseUrl: 'http://localhost/u/alice/', enabled: true, transport,
      current: options.side ? { ...from, nativeSessionId: 'primary' } : current, loaded: [current], apply, follow, blocked: () => blocked });
    return notice;
  }
  const view = await render(<Fixture />);
  return { view, apply, follow, receive: (value = migration) => act(async () => receive(value)),
    select: (value: typeof from) => act(async () => select(value)), unblock: () => { blocked = false; } };
}
it('replaces references once, waits five foreground seconds and retains an original-session link', async () => {
  const f = await fixture(); await f.receive(); await f.receive();
  expect(f.apply).toHaveBeenCalledOnce();
  expect(f.view.textContent).toContain('5s');
  await act(async () => vi.advanceTimersByTimeAsync(4750)); expect(f.follow).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(250)); expect(f.follow).toHaveBeenCalledOnce();
  expect(f.view.querySelector('a')?.href).toContain('session=old');
  expect(f.view.querySelector('a')?.href).toContain('keepOriginal=1');
  await f.select(from); await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(f.follow).toHaveBeenCalledOnce();
});
it('pauses during mobile sleep and while the initiating draft is being restored', async () => {
  const f = await fixture({ block: true }); await f.receive();
  await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(f.follow).not.toHaveBeenCalled();
  f.unblock();
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => vi.advanceTimersByTimeAsync(60000)); expect(f.follow).not.toHaveBeenCalled();
  hidden.mockReturnValue('visible');
  await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(f.follow).toHaveBeenCalledOnce();
});
it('honors an explicit original-session link while still updating Track and favorites', async () => {
  window.history.replaceState(null, '', '/?host=host&provider=codex&session=old&keepOriginal=1');
  const f = await fixture(); await f.receive();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(f.apply).toHaveBeenCalledOnce(); expect(f.follow).not.toHaveBeenCalled();
});
it('keeps failures actionable and catches both automatic and manual reconnect failures', async () => {
  const f = await fixture({ fail: true }); await f.receive();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(f.view.textContent).toContain('could not be opened');
  await act(async () => f.view.querySelector('button')!.click());
  expect(f.follow).toHaveBeenCalledTimes(2); expect(f.view.textContent).toContain('Retry');
});
it('also follows a migrated session loaded in a secondary window', async () => {
  const f = await fixture({ side: true }); await f.receive();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(f.follow).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'new' }), expect.objectContaining({ nativeSessionId: 'old' }));
});
