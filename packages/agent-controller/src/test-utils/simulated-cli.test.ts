import { AgentRuntimeError, AgentSessionInUseError, type AgentProviderBehaviour, type AgentSession, type ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { simulatedCli } from './simulated-cli.js';

/** Each declaration as an adapter states it, with only the concurrency fields a test varies. */
const declared = (concurrency: AgentProviderBehaviour['concurrency']): AgentProviderBehaviour => ({
  concurrency, reread: { order: 'live', paging: 'turns', withoutAttach: false, cost: 'page' }, resume: { cost: 'subscription', deadlineMs: 90_000 },
  input: { identity: 'none', whileBusy: 'steer' }, limits: { signal: 'event' }, failures: { runtime: [], inUse: ['writer_elsewhere'] }, liveOnly: [],
});
const sharedDaemon = declared({ model: 'shared_clients', probe: 'lock_file', othersVisible: 'live', unloadAfterLastClientMs: 70_000 });
const singleWriter = declared({ model: 'single_writer', probe: 'native', othersVisible: 'never' });
const forking = declared({ model: 'fork_on_divergence', probe: 'none', othersVisible: 'on_reread' });

afterEach(() => { vi.useRealTimers(); });
/** Fake timers and clock; `setImmediate` stays real, so a test can tell that a session has nothing more to emit. */
const fakeTimers = (now?: number) => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], ...(now === undefined ? {} : { now }) });
const open = (cli: ReturnType<typeof simulatedCli>, id = 'thread-1') => cli.adapter.resumeSession({ providerId: 'simulated', sessionId: id, opaque: '{}' });
/** Everything a session emitted so far, without waiting for more. */
async function drained(session: AgentSession): Promise<ProviderObservation[]> {
  const seen: ProviderObservation[] = [];
  const iterator = session.observe()[Symbol.asyncIterator]();
  for (;;) {
    const next = await Promise.race([iterator.next(), new Promise<'idle'>(resolve => { setImmediate(() => resolve('idle')); })]);
    if (next === 'idle' || next.done) return seen;
    if (next.value.type === 'observation') seen.push(next.value);
  }
}
const texts = (observations: ProviderObservation[]) => observations.flatMap(({ event }) => event.type === 'timeline' && 'text' in event.item ? [event.item.text] : []);

describe('the simulated CLI', () => {
  it('keeps a session loaded while this process is its client and for the declared unload time after (S1)', async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: sharedDaemon, sessions: { 'thread-1': ['Hello', 'Hi'] } });
    const session = await open(cli);
    expect(cli.native('thread-1')).toMatchObject({ loaded: true, clients: 1, resumes: 1 });
    await session.dispose();
    await vi.advanceTimersByTimeAsync(69_999);
    expect(cli.native('thread-1').loaded).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(cli.native('thread-1')).toMatchObject({ loaded: false, clients: 0 });
  });

  it('unloads a session at once when the CLI declares no unload time (S1)', async () => {
    const cli = simulatedCli({ behaviour: singleWriter });
    await (await open(cli)).dispose();
    expect(cli.native('thread-1').loaded).toBe(false);
  });

  it("runs a send as a turn whose items reach history when it ends, and reads history back at the next resume (S2)", async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: sharedDaemon, sessions: { 'thread-1': ['Hello', 'Hi'] }, turnMs: 500 });
    const session = await open(cli);
    await session.sendMessage('Next');
    expect((await session.runtimeInfo()).status).toBe('running');
    expect(cli.native('thread-1').history).toEqual(['Hello', 'Hi']);
    await vi.advanceTimersByTimeAsync(500);
    expect((await session.runtimeInfo()).status).toBe('idle');
    const live = await drained(session);
    expect(live.map(({ event }) => event.type)).toEqual(['timeline', 'timeline', 'turn_started', 'timeline', 'timeline', 'turn_completed']);
    expect(texts(live)).toEqual(['Hello', 'Hi', 'Next', 'Reply to Next']);
    expect(live.filter(({ event }) => event.type === 'timeline').every(({ itemIdentity }) => itemIdentity?.completes)).toBe(true);
    await session.dispose();
    expect(texts(await drained(await open(cli)))).toEqual(['Hello', 'Hi', 'Next', 'Reply to Next']);
  });

  it("shows another client's turn live to this process's client, and loads the session while it runs (S3)", async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: sharedDaemon, turnMs: 300 });
    const session = await open(cli);
    const written = cli.externalWriter('thread-1', { text: 'From a terminal' });
    await vi.advanceTimersByTimeAsync(300);
    expect(await written).toBe('written');
    expect(texts(await drained(session))).toEqual(['From a terminal', 'Reply to From a terminal']);
    await session.dispose();
    const alone = cli.externalWriter('thread-1', { text: 'Again', turnMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await alone).toBe('written');
    expect(cli.native('thread-1').loaded).toBe(true);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(cli.native('thread-1').loaded).toBe(false);
  });

  it('refuses a writer elsewhere while the session is loaded, and refuses a resume while one writes (S4)', async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: sharedDaemon });
    const session = await open(cli);
    expect(await cli.externalWriter('thread-1', { text: 'Separate', separate: true })).toBe('refused');
    await session.dispose();
    expect(await cli.externalWriter('thread-1', { text: 'Separate', separate: true })).toBe('refused');
    await vi.advanceTimersByTimeAsync(70_000);
    const writing = cli.externalWriter('thread-1', { text: 'Separate', separate: true, turnMs: 30_000, retryAfterMs: 5000 });
    const refused = await open(cli).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentSessionInUseError);
    expect(refused).toMatchObject({ reason: 'writer_elsewhere', retryAfterMs: 5000 });
    expect(cli.native('thread-1').writerElsewhere).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await writing).toBe('written');
    expect(texts(await drained(await open(cli)))).toEqual(['Separate', 'Reply to Separate']);
  });

  it('refuses every writer elsewhere for a single writer that this process holds (S4)', async () => {
    const cli = simulatedCli({ behaviour: singleWriter });
    await open(cli);
    expect(await cli.externalWriter('thread-1', { text: 'Elsewhere' })).toBe('refused');
  });

  it('forks a transcript two writers write at once: a reread shows the newest branch, the resident client keeps its own (S5)', async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: forking, sessions: { 'thread-1': ['Base', 'Base reply'] }, turnMs: 1000 });
    const session = await open(cli);
    await session.sendMessage('PAGE');
    const terminal = cli.externalWriter('thread-1', { text: 'TERM', turnMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await terminal).toBe('written');
    expect(cli.native('thread-1').history).toEqual(['Base', 'Base reply', 'TERM', 'Reply to TERM']);
    expect(texts(await drained(session))).toEqual(['Base', 'Base reply', 'PAGE', 'Reply to PAGE']);
    expect(cli.native('thread-1').updatedAt).toBe(Date.now());
  });

  it('shows the branch written last on a reread when two writes end in the same millisecond (S5)', async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: forking, sessions: { 'thread-1': ['Base', 'Base reply'] }, turnMs: 1000 });
    const session = await open(cli);
    await session.sendMessage('PAGE');
    const terminal = cli.externalWriter('thread-1', { text: 'TERM', turnMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await terminal).toBe('written');
    expect(cli.native('thread-1').history).toEqual(['Base', 'Base reply', 'TERM', 'Reply to TERM']);
  });

  it('answers a slow resume after its delay, and a hung one only once healed (S6)', async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: sharedDaemon });
    cli.faults.slowResume(4000);
    let opened = false;
    void open(cli).then(() => { opened = true; });
    await vi.advanceTimersByTimeAsync(3999);
    expect(opened).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened).toBe(true);
    cli.faults.heal();
    cli.faults.hangResume();
    let answered = false;
    void open(cli, 'thread-2').then(() => { answered = true; });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(answered).toBe(false);
    cli.faults.heal();
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(true);
    cli.faults.hangResume({ once: true });
    let hung = false;
    void open(cli, 'thread-3').then(() => { hung = true; });
    await open(cli, 'thread-4');
    expect(hung).toBe(false);
  });

  it('refuses a resume with a typed usage limit until the limit resets (S6)', async () => {
    fakeTimers(1_000_000);
    const cli = simulatedCli({ behaviour: sharedDaemon });
    cli.faults.usageLimit({ resetsAt: 1_060_000 });
    const limited = await open(cli).catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(AgentRuntimeError);
    expect(limited).toMatchObject({ code: 'native_usage_limited', resetsAt: 1_060_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await open(cli)).capabilities.sendMessage).toBe(true);
  });

  it('fails each turn with native_usage_limited after its user message until the limit resets, and says when it resets meanwhile (S6)', async () => {
    fakeTimers(1_000_000);
    const cli = simulatedCli({ behaviour: sharedDaemon, turnMs: 100 });
    cli.faults.usageLimit({ resetsAt: 1_060_000, at: 'turn' });
    const session = await open(cli);
    await session.sendMessage('Over the limit');
    const limited = (await drained(session)).map(({ event }) => event);
    expect(limited.find(event => event.type === 'turn_failed')).toMatchObject({ code: 'native_usage_limited' });
    expect((await session.runtimeInfo()).usageLimit).toEqual({ resetsAt: 1_060_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    await session.sendMessage('After the reset');
    await vi.advanceTimersByTimeAsync(100);
    expect((await session.runtimeInfo()).usageLimit).toBeUndefined();
    expect(cli.native('thread-1').history).toEqual(['After the reset', 'Reply to After the reset']);
  });

  it('fails a turn whose CLI exits with native_exited and ends the stream, and leaves a hung turn running (S7)', async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: sharedDaemon, turnMs: 100 });
    const crashing = await open(cli);
    cli.faults.crash();
    await crashing.sendMessage('Crash');
    await vi.advanceTimersByTimeAsync(100);
    const ended = await drained(crashing);
    expect(ended.at(-1)?.event).toMatchObject({ type: 'turn_failed', code: 'native_exited' });
    expect((await crashing.runtimeInfo()).status).toBe('closed');
    expect(cli.native('thread-1').clients).toBe(0);
    const hanging = await open(cli, 'thread-2');
    cli.faults.hang();
    await hanging.sendMessage('Hang');
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await hanging.runtimeInfo()).status).toBe('running');
    expect(texts(await drained(hanging))).toEqual(['Hang']);
  });

  it('sends an item of a kind the adapter does not know in every history read and turn until healed (S8)', async () => {
    fakeTimers();
    const cli = simulatedCli({ behaviour: sharedDaemon, sessions: { 'thread-1': ['Hello', 'Hi'] }, turnMs: 100 });
    cli.faults.unknownEvent('hologram');
    const session = await open(cli);
    await session.sendMessage('Show');
    await vi.advanceTimersByTimeAsync(100);
    const kinds = (await drained(session)).flatMap(({ event }) => event.type === 'timeline' ? [event.item.type] : []);
    expect(kinds).toEqual(['user_message', 'assistant_message', 'hologram', 'user_message', 'hologram', 'assistant_message']);
    cli.faults.heal();
    expect((await drained(await open(cli))).some(({ event }) => event.type === 'timeline' && event.item.type === 'hologram')).toBe(false);
  });

  it('declares the behaviour it plays, so a Controller reads it as an adapter states it (S9 runs every test above on fake timers)', () => {
    expect(simulatedCli({ behaviour: forking }).adapter.descriptor.behaviour).toBe(forking);
  });
});
