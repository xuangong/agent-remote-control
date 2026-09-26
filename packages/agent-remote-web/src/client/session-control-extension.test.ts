import { expect, it } from 'vitest';
import { SessionHandoff, SessionHandoffRejectedError, SessionHandoffScope } from './session-control-extension.js';

it('retains uncertain handoffs when a pre-attachment consumer switches targets', async () => {
  const handoff = new SessionHandoff();
  const requests: { generation: string; checkOnly: boolean }[] = [];
  for (const generation of ['target-a/owner-one', 'target-b/owner-two', 'target-a/owner-one']) {
    await expect(handoff.run(generation, async options => {
      requests.push({ generation, checkOnly: options.checkOnly });
      throw Object.assign(new Error('No reply'), { code: 'host_timeout' });
    })).rejects.toMatchObject({ code: 'host_timeout' });
  }
  expect(requests.map(request => request.checkOnly)).toEqual([false, false, true]);
  expect(handoff.getState('target-a/owner-one')?.phase).toBe('unknown');
  expect(handoff.getState('target-b/owner-two')?.phase).toBe('unknown');
}, 1000);

it('does not convert a failed status check into permission for another interruption', async () => {
  const handoff = new SessionHandoff();
  await expect(handoff.run('owner', async () => { throw Object.assign(new Error('No reply'), { code: 'operation_outcome_unknown' }); })).rejects.toThrow();
  await expect(handoff.run('owner', async options => {
    expect(options.checkOnly).toBe(true);
    throw new SessionHandoffRejectedError('Sign in');
  })).rejects.toThrow();
  await handoff.run('owner', async options => { expect(options.checkOnly).toBe(true); options.onRestoring(); }, { checkOnly: false });
  expect(handoff.getState('owner')).toBeUndefined();
}, 1000);

it('allows another interruption only after an explicit no-effect rejection', async () => {
  const handoff = new SessionHandoff();
  await expect(handoff.run('owner', async () => { throw new SessionHandoffRejectedError('Access unavailable'); })).rejects.toThrow('Access unavailable');
  expect(handoff.getState('owner')).toMatchObject({ phase: 'failed', message: 'Access unavailable' });
  await handoff.run('owner', async options => { expect(options.checkOnly).toBe(false); });
  expect(handoff.getState('owner')).toBeUndefined();
}, 1000);

it('keeps uncertainty if a no-effect rejection happens after native restoration started', async () => {
  const handoff = new SessionHandoff();
  await expect(handoff.run('owner', async options => {
    options.onRestoring();
    throw new SessionHandoffRejectedError('Browser control was rejected');
  })).rejects.toThrow();
  expect(handoff.getState('owner')?.phase).toBe('unknown');
}, 1000);

it('isolates targets and authority scopes without discarding unconfirmed generations', async () => {
  const scope = new SessionHandoffScope();
  const a = scope.forTarget('host-a/provider/native');
  const b = scope.forTarget('host-b/provider/native');
  await expect(a.run('owner', async () => { throw new Error('No reply'); })).rejects.toThrow();
  await expect(b.run('owner', async options => { expect(options.checkOnly).toBe(false); throw new Error('No reply'); })).rejects.toThrow();
  await scope.forTarget('host-a/provider/native').run('owner', async options => { expect(options.checkOnly).toBe(true); });
  expect(b.getState('owner')?.phase).toBe('unknown');
  expect(new SessionHandoffScope().forTarget('host-b/provider/native').getState('owner')).toBeUndefined();
}, 1000);

it('prevents concurrent consumers from interrupting the same target twice', async () => {
  const scope = new SessionHandoffScope();
  let release!: () => void;
  const running = scope.forTarget('target').run('owner', () => new Promise<void>(resolve => { release = resolve; }));
  try {
    await expect(scope.forTarget('target').run('owner', async () => { throw new Error('Must not dispatch'); })).rejects.toMatchObject({ code: 'native_control_in_progress' });
    expect(scope.forTarget('target').getState('owner')?.phase).toBe('taking');
  } finally { release(); await running; }
}, 1000);

it('treats an aborted native endpoint request as uncertain', async () => {
  const handoff = new SessionHandoff();
  await expect(handoff.run('owner', async () => { throw new DOMException('Request aborted', 'AbortError'); })).rejects.toThrow();
  await handoff.run('owner', async options => { expect(options.checkOnly).toBe(true); });
}, 1000);

it('does not repeat an interruption after an unrecognized coded transport failure', async () => {
  const handoff = new SessionHandoff();
  const requests: boolean[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(handoff.run('owner', async options => {
      requests.push(options.checkOnly);
      throw Object.assign(new Error('Reply lost after dispatch'), { code: 'ECONNRESET' });
    })).rejects.toMatchObject({ code: 'ECONNRESET' });
  }
  expect(requests).toEqual([false, true]);
  expect(handoff.getState('owner')?.phase).toBe('unknown');
}, 1000);
