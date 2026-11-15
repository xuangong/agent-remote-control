import { describe, expect, it } from 'vitest';

import { createHostStreamOpener, HostStreamRefusal, type HostStreamContext, type HostStreamEntry, type HostStreamSink } from './journal-host-stream.js';

function fixture(overrides: Partial<Pick<HostStreamContext, 'recover' | 'capacity' | 'write'>> = {}) {
  const streams = new Map<string, HostStreamEntry>();
  const written: Array<Record<string, unknown>> = [];
  const timers = new Map<number, () => void>();
  const diagnostics: string[] = [];
  let nextTimer = 0;
  const opener = createHostStreamOpener({
    streams, publicAgentId: 'public-1', runtimeAgentId: () => 'runtime-1', subject: 'alice', authorized: () => true,
    recover: overrides.recover ?? (async () => undefined), capacity: overrides.capacity ?? (() => undefined),
    write: message => { overrides.write?.(message); written.push(message as unknown as Record<string, unknown>); },
    scheduler: { setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: timer => { timers.delete(timer as number); } },
    openTimeoutMs: 30_000, diagnostic: details => diagnostics.push(details.event),
  });
  const seen = { frames: [] as string[], ready: 0, ended: [] as Array<[number, string]> };
  const sink: HostStreamSink = { frame: raw => seen.frames.push(raw), ready: () => { seen.ready += 1; }, ended: (code, reason) => seen.ended.push([code, reason]) };
  /** What the broker does when the Controller accepts the stream. */
  const accept = () => {
    const [streamId, entry] = [...streams][0]!;
    entry.ready = true;
    for (const buffered of entry.buffered) written.push({ uplinkVersion: 2, type: 'stream_message', streamId, message: buffered });
    entry.buffered = [];
    entry.onReady?.();
  };
  return { opener, streams, written, timers, diagnostics, seen, sink, accept };
}

const cancel = JSON.stringify({ type: 'cancel', payload: { agentId: 'public-1', requestId: 'r1' } });

describe('a Controller stream', () => {
  it('registers an entry, rewrites identities and holds messages until the Controller accepts the stream', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [streamId, entry] = [...f.streams][0]!;
    expect(f.written).toEqual([{ uplinkVersion: 2, type: 'stream_open', streamId, sessionId: 'runtime-1' }]);
    expect(entry).toMatchObject({ publicAgentId: 'public-1', runtimeAgentId: 'runtime-1', subject: 'alice', ready: false });
    expect(f.diagnostics).toEqual(['stream_opening']);
    stream.send(cancel);
    expect(f.written).toHaveLength(1);
    f.accept();
    expect(f.seen.ready).toBe(1);
    expect(f.written.at(-1)).toEqual({ uplinkVersion: 2, type: 'stream_message', streamId, message: JSON.stringify({ type: 'cancel', payload: { agentId: 'runtime-1', requestId: 'r1' } }) });
    stream.send(cancel);
    expect(f.written).toHaveLength(3);
  });

  it('passes the Controller\'s frames and its end to the sink', async () => {
    const f = fixture();
    await f.opener.open(f.sink);
    const [, entry] = [...f.streams][0]!;
    entry.socket.send('frame-1');
    expect(f.seen.frames).toEqual(['frame-1']);
    expect(entry.socket.readyState).toBe(1);
    entry.socket.close(1012, 'Remote Host disconnected');
    expect(f.seen.ended).toEqual([[1012, 'Remote Host disconnected']]);
    expect(entry.socket.readyState).not.toBe(1);
    entry.socket.send('late');
    expect(f.seen.frames).toEqual(['frame-1']);
  });

  it('refuses with the reason when the session cannot be recovered, a limit is reached or the Host cannot be written, and leaves nothing behind', async () => {
    const offline = Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' });
    const recovery = fixture({ recover: async () => { throw offline; } });
    await expect(recovery.opener.open(recovery.sink)).rejects.toMatchObject({ code: 'host_offline', message: 'The Remote Host is offline.' });
    const full = fixture({ capacity: () => 'host' });
    await expect(full.opener.open(full.sink)).rejects.toMatchObject({ code: 'session_stream_capacity' });
    const account = fixture({ capacity: () => 'account' });
    await expect(account.opener.open(account.sink)).rejects.toBeInstanceOf(HostStreamRefusal);
    const unwritable = fixture({ write: () => { throw offline; } });
    await expect(unwritable.opener.open(unwritable.sink)).rejects.toMatchObject({ code: 'host_offline' });
    for (const each of [recovery, full, account, unwritable]) { expect(each.streams.size).toBe(0); expect(each.timers.size).toBe(0); }
  });

  it('closes the stream and tells the Controller when the browser leaves', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [streamId] = [...f.streams][0]!;
    stream.close();
    expect(f.written.at(-1)).toEqual({ uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' });
    expect(f.streams.size).toBe(0);
    expect(f.timers.size).toBe(0);
    expect(f.seen.ended).toEqual([]);
    expect(() => stream.send(cancel)).toThrow(HostStreamRefusal);
  });

  it('ends the stream when the Controller does not accept it in time', async () => {
    const f = fixture();
    await f.opener.open(f.sink);
    [...f.timers.values()][0]!();
    expect(f.seen.ended).toEqual([[1013, 'Remote stream opening timed out']]);
    expect(f.streams.size).toBe(0);
    expect(f.written.filter(message => message.type === 'stream_close')).toHaveLength(1);
    expect(f.written.at(-1)).toMatchObject({ type: 'stream_close', code: 1000, reason: 'Browser disconnected' });
    expect(f.diagnostics).toEqual(['stream_opening', 'stream_open_timeout', 'stream_closed']);
  });

  it('holds at most 32 messages before the Controller accepts the stream', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    for (let at = 0; at < 32; at++) stream.send(cancel);
    let refusal: unknown;
    try { stream.send(cancel); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'host_stream_not_ready' });
  });
});

describe('a Controller stream and the Host\'s stream accounting', () => {
  it('counts against the per-Host and per-account limits while it is open and frees its slot when it ends', async () => {
    const streams = new Map<string, HostStreamEntry>();
    const limits = { host: 2, account: 1 };
    const make = (subject: string) => createHostStreamOpener({
      streams, publicAgentId: 'public-1', runtimeAgentId: () => 'runtime-1', subject, authorized: () => true, recover: async () => undefined,
      capacity: () => streams.size >= limits.host ? 'host' : [...streams.values()].filter(entry => entry.subject === subject).length >= limits.account ? 'account' : undefined,
      write: () => undefined, scheduler: { setTimeout: () => 0, clearTimeout: () => undefined }, openTimeoutMs: 30_000, diagnostic: () => undefined,
    });
    const sink: HostStreamSink = { frame: () => undefined, ready: () => undefined, ended: () => undefined };
    const first = await make('alice').open(sink);
    await expect(make('alice').open(sink)).rejects.toMatchObject({ code: 'session_stream_capacity' });
    await make('bob').open(sink);
    await expect(make('carol').open(sink)).rejects.toMatchObject({ code: 'session_stream_capacity' });
    first.close();
    await expect(make('alice').open(sink)).resolves.toBeDefined();
  });

  it('frees its slot when the Controller ends the stream, as the broker does by deleting the entry and closing the socket', async () => {
    const streams = new Map<string, HostStreamEntry>();
    const opener = createHostStreamOpener({
      streams, publicAgentId: 'public-1', runtimeAgentId: () => 'runtime-1', authorized: () => true, recover: async () => undefined,
      capacity: () => streams.size >= 1 ? 'host' : undefined, write: () => undefined,
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined }, openTimeoutMs: 30_000, diagnostic: () => undefined,
    });
    const sink: HostStreamSink = { frame: () => undefined, ready: () => undefined, ended: () => undefined };
    await opener.open(sink);
    await expect(opener.open(sink)).rejects.toMatchObject({ code: 'session_stream_capacity' });
    const [streamId, entry] = [...streams][0]!;
    streams.delete(streamId);
    entry.socket.close(1000, 'Closed by the Controller');
    await expect(opener.open(sink)).resolves.toBeDefined();
  });

  it('ends once and tells the Controller once when the broker closes the socket while the entry is registered', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [streamId, entry] = [...f.streams][0]!;
    entry.socket.close(1008, 'Invalid Remote Host session identity');
    expect(f.streams.size).toBe(0);
    expect(f.written.filter(message => message.type === 'stream_close')).toEqual([{ uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }]);
    expect(f.seen.ended).toEqual([[1008, 'Invalid Remote Host session identity']]);
    expect(f.timers.size).toBe(0);
    stream.close();
    expect(f.written.filter(message => message.type === 'stream_close')).toHaveLength(1);
    expect(() => stream.send(cancel)).toThrow(HostStreamRefusal);
  });

  it('writes no stream_close of its own when access is revoked and the broker already removed the entry and told the Controller', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const [streamId, entry] = [...f.streams][0]!;
    f.streams.delete(streamId);
    entry.socket.close(1008, 'Host share revoked');
    expect(f.streams.size).toBe(0);
    expect(f.seen.ended).toEqual([[1008, 'Host share revoked']]);
    expect(f.written.filter(message => message.type === 'stream_close')).toEqual([]);
    expect(f.timers.size).toBe(0);
    stream.close();
    expect(f.written.filter(message => message.type === 'stream_close')).toEqual([]);
  });

  it('ends with 1012 and does not throw when the Host disconnects while the entry is registered and the Host cannot be written', async () => {
    let offline = false;
    const f = fixture({ write: () => { if (offline) throw new Error('offline'); } });
    await f.opener.open(f.sink);
    offline = true;
    for (const entry of f.streams.values()) entry.socket.close(1012, 'Remote Host disconnected');
    f.streams.clear();
    expect(f.seen.ended).toEqual([[1012, 'Remote Host disconnected']]);
    expect(f.streams.size).toBe(0);
    expect(f.timers.size).toBe(0);
  });

  it('refuses a frame that pushes the held bytes over 1 MiB while fewer than 32 messages are held', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const big = JSON.stringify({ type: 'cancel', payload: { agentId: 'public-1', requestId: 'x'.repeat(400 * 1024) } });
    stream.send(big);
    stream.send(big);
    expect(() => stream.send(big)).toThrow(expect.objectContaining({ code: 'host_stream_not_ready' }));
    expect(f.streams.values().next().value!.buffered).toHaveLength(2);
  });

  it('refuses a frame that addresses another session', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    const other = JSON.stringify({ type: 'cancel', payload: { agentId: 'someone-else', requestId: 'r1' } });
    expect(() => stream.send(other)).toThrow(expect.objectContaining({ code: 'invalid_session_target' }));
    expect(f.streams.values().next().value!.buffered).toHaveLength(0);
  });

  it('refuses a message the identity rewrite cannot read without holding it', async () => {
    const f = fixture();
    const stream = await f.opener.open(f.sink);
    expect(() => stream.send('not json')).toThrow();
    f.accept();
    expect(f.written).toHaveLength(1);
  });
});
