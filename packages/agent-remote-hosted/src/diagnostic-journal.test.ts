import { afterEach, expect, it, vi } from 'vitest';
import { createDiagnosticJournal } from './diagnostic-journal.js';
import { pruneRelayDiagnostics, type RelayDiagnostic } from './relay-diagnostics.js';
afterEach(()=>vi.useRealTimers());
it.each(['flush', 'close'] as const)('drains a record queued between save completion and %s', async operation => {
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const snapshots: RelayDiagnostic[][] = [];
 const journal = createDiagnosticJournal({ storage: { save(entries) { snapshots.push(entries); return snapshots.length === 1 ? gate : Promise.resolve(); } } });
 journal.record('one', { event: 'host_registered' });
 await Promise.resolve();
 const drained = gate.then(async () => { journal.record('one', { event: 'host_disconnected' }); await journal[operation](); });
 release(); await drained;
 expect(snapshots.map(entries => entries.map(entry => entry.event))).toEqual([['host_registered'], ['host_registered', 'host_disconnected']]);
 await journal.close();
});

it('retries a newer snapshot after an in-flight write fails without spinning on repeated storage failure', async () => {
 let reject!: (error: Error) => void;
 const gate = new Promise<void>((_resolve, failure) => { reject = failure; });
 const snapshots: RelayDiagnostic[][] = [];
 const journal = createDiagnosticJournal({ storage: { save(entries) { snapshots.push(entries); return snapshots.length === 1 ? gate : Promise.reject(new Error('disk full')); } } });
 journal.record('one', { event: 'host_registered' }); await Promise.resolve();
 journal.record('one', { event: 'host_disconnected' }); reject(new Error('disk full')); await journal.flush();
 expect(snapshots.map(entries => entries.map(entry => entry.event))).toEqual([['host_registered'], ['host_registered', 'host_disconnected']]);
 await journal.close(); expect(snapshots).toHaveLength(2);
});

it('keeps an already waiting flush pending until a replacement write completes', async () => {
 let releaseFirst!: () => void, releaseSecond!: () => void;
 const first = new Promise<void>(resolve => { releaseFirst = resolve; });
 const second = new Promise<void>(resolve => { releaseSecond = resolve; });
 let saves = 0, flushed = false;
 const journal = createDiagnosticJournal({ storage: { save() { return ++saves === 1 ? first : second; } } });
 journal.record('one', { event: 'host_registered' }); await Promise.resolve();
 first.then(() => journal.record('one', { event: 'host_disconnected' }));
 const drained = journal.flush().then(() => { flushed = true; });
 releaseFirst();
 for (let index = 0; index < 8; index++) await Promise.resolve();
 expect(saves).toBe(2); expect(flushed).toBe(false);
 releaseSecond(); await drained; expect(flushed).toBe(true); await journal.close();
});

it('buffers independently per host and removes only acknowledged batches',async()=>{
 vi.useFakeTimers();let saved:RelayDiagnostic[]=[];
 const journal=createDiagnosticJournal({storage:{save:async entries=>{saved=structuredClone(entries);}}});
 journal.record('one',{event:'host_disconnected',reason:'heartbeat_timeout'});
 journal.record('two',{event:'host_registered'});await journal.flush();
 const initial=structuredClone(saved);const sender=vi.fn(async()=>({status:503}));
 journal.connect('one',sender);await vi.advanceTimersByTimeAsync(1000);
 expect(sender.mock.calls[0]?.[0]).toEqual([initial[0]]);expect(saved).toHaveLength(2);
 sender.mockResolvedValue({status:204});await vi.advanceTimersByTimeAsync(30000);await journal.flush();
 expect(saved).toEqual([initial[1]]);await journal.close();
});
it('retains events across restart and does not let stale acknowledgements discard reconnect evidence',async()=>{
 vi.useFakeTimers();let saved:RelayDiagnostic[]=[];
 let journal=createDiagnosticJournal({storage:{save:async entries=>{saved=structuredClone(entries);}}});
 journal.record('one',{event:'rpc_timeout',operation:'attach'});await journal.close();
 journal=createDiagnosticJournal({storage:{initial:saved,save:async entries=>{saved=structuredClone(entries);}}});
 let done!:(value:{status:number})=>void;
 const stop=journal.connect('one',()=>new Promise(resolve=>{done=resolve;}));await vi.advanceTimersByTimeAsync(1000);
 stop();journal.record('one',{event:'host_disconnected'});done({status:204});await Promise.resolve();await journal.flush();
 expect(saved).toHaveLength(2);
 const next=vi.fn(async()=>({status:204}));journal.connect('one',next);await vi.advanceTimersByTimeAsync(1000);
 expect(next.mock.calls[0]?.[0]).toHaveLength(2);await journal.close();
});
it('isolates failed persistence and stops probing legacy controllers until reconnect',async()=>{
 vi.useFakeTimers();const store={save:vi.fn(async()=>{throw new Error('disk full');})};
 const journal=createDiagnosticJournal({storage:store});journal.record('one',{event:'host_registered'});await journal.flush();
 const sender=vi.fn(async()=>({status:404}));journal.connect('one',sender);await vi.advanceTimersByTimeAsync(1000);
 journal.record('one',{event:'rpc_failed'});await vi.advanceTimersByTimeAsync(90000);expect(sender).toHaveBeenCalledTimes(1);
 journal.connect('one',sender);await vi.advanceTimersByTimeAsync(1000);expect(sender).toHaveBeenCalledTimes(2);await journal.close();
});
it('bounds per-host and global retention and drops expired or unvalidated input',()=>{
 const now=Date.now();const entry=(id:string,hostId='one'):RelayDiagnostic=>({id,hostId,relayInstanceId:'relay',source:'relay',event:'host_registered',timestamp:new Date(now).toISOString()});
 expect(pruneRelayDiagnostics(Array.from({length:300},(_,i)=>entry('e'+i)),now)).toHaveLength(256);
 expect(pruneRelayDiagnostics(Array.from({length:5000},(_,i)=>entry('e'+i,'h'+i)),now)).toHaveLength(4096);
 expect(pruneRelayDiagnostics([{...entry('old'),timestamp:new Date(now-86400001).toISOString()},{...entry('bad'),body:'secret'},entry('ok')],now).map(e=>e.id)).toEqual(['ok']);
});

it('preserves original runtime metadata through recovery and ignores malformed optional identifiers', async () => {
 let saved: RelayDiagnostic[] = [];
 const first = createDiagnosticJournal({ context: { runtimeInstanceId: 'runtime-1', workerVersionId: 'version-1', startReason: 'runtime_start' },
   storage: { async save(entries) { saved = entries; } } });
 first.record('one', { event: 'relay_started' }); await first.close();
 const original = saved[0]!;
 const recovered = createDiagnosticJournal({ context: { runtimeInstanceId: 'runtime-1', workerVersionId: 'version-1', startReason: 'core_recovery' },
   storage: { initial: saved, async save(entries) { saved = entries; } } });
 recovered.record('one', { event: 'relay_started' }); await recovered.close();
 expect(saved[0]).toEqual(original);
 expect(saved[1]).toMatchObject({ runtimeInstanceId: 'runtime-1', workerVersionId: 'version-1', startReason: 'core_recovery' });
 expect(saved[1]!.relayInstanceId).not.toBe(original.relayInstanceId);
 const malformed = createDiagnosticJournal({ context: { workerVersionId: 'private\ntext' }, storage: { async save(entries) { saved = entries; } } });
 malformed.record('one', { event: 'host_registered' }); await malformed.close();
 expect(saved).toHaveLength(1);
 expect(saved[0]).not.toHaveProperty('workerVersionId');
});
