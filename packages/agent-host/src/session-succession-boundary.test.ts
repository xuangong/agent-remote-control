import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AgentOperationRejectedError, type AgentInputPart, type AgentSession } from '@orchardworks/agent-provider-sdk';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
import { createHash } from 'node:crypto';
import { nativeSessionRefKey } from '@orchardworks/agent-remote-protocol';
import { createOperationCache, type MutationEntry } from '@orchardworks/agent-remote-relay';
import type { AgentInputAcceptance, AgentPreparedTextInput, AgentSessionNativeEvidence } from '@orchardworks/agent-provider-sdk';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
const ref = (nativeSessionId: string) => ({controllerId:'host',providerId:'fixture',nativeSessionId});
const operation = (operationId: string) => ({operationId,kind:'send_message' as const,parameters:{text:'hello'},maximumResultBytes:1024});
async function fixture() {
 const root = await mkdtemp(join(tmpdir(),'arc-succession-boundary-')); roots.push(root);
 const contexts = new SessionSuccessionContextStore(root); await contexts.ready;
 await contexts.attach({operationId:'handoff',roleId:'role',roleRevision:2,source:ref('A'),target:ref('B'),capturedAt:'2026-10-10T00:00:00Z',boundary:{epoch:'e',seq:1},text:'[{"role":"user","text":"source work"}]',itemCount:1});
 const messages: unknown[] = []; let reject = false, superseded = false;
 const native = {async sendMessage(text:string) { if(reject) throw new AgentOperationRejectedError('agent_busy','Busy'); messages.push(text); }, async sendMessageContent(parts: readonly AgentInputPart[]) {messages.push(parts);}, async executeCommand() {messages.push('command');}, async setSessionSetting() {messages.push('setting');}} as unknown as AgentSession;
 const boundary = new SessionSuccessionBoundary(contexts, target => {if(superseded || target.nativeSessionId==='A') throw new Error('Session superseded');}, target => target.nativeSessionId==='B' ? {roleId:'role',roleRevision:2} : undefined);
 const session = boundary.wrap(ref('B'),native);
 return {root,contexts,boundary,session,messages,reject:()=>{reject=true;},supersede:()=>{superseded=true;}};
}
test('requires admitted identity and serializes first inputs from different devices',async()=>{
 const f=await fixture();
 await expect(f.session.sendMessage('bypass')).rejects.toThrow(/identity/i);
 const first = f.boundary.run(operation('one'),'browser',()=>f.session.sendMessage('first'));
 const second = f.boundary.run(operation('two'),'tpm',()=>f.session.sendMessage('second'));
 await first; await expect(second).rejects.toThrow(/unresolved/i);
 expect(f.messages).toHaveLength(1); expect(f.messages[0]).toContain('source work'); expect(f.messages[0]).toContain('first');
 expect(f.contexts.read('handoff').state).toBe('accepted');
});
test('injects rich input without dropping images and keeps scoped identities distinct',async()=>{
 const f=await fixture(); const image={type:'image' as const,bytes:new Uint8Array([1,2,3]),mediaType:'image/png'};
 await f.boundary.run(operation('same'),'browser',()=>f.session.sendMessageContent!([{type:'text',text:'look'},image]));
 const parts=f.messages[0] as AgentInputPart[];
 expect(parts.at(-1)).toEqual(image); expect(parts[0]).toMatchObject({type:'text',text:expect.stringContaining('source work')});
 await expect(f.boundary.run(operation('same'),'tpm',()=>f.session.sendMessage('different'))).rejects.toThrow(/unresolved/i);
});
test('leaves definite rejection pending and fences execution commands and superseded mutations',async()=>{
 const f=await fixture(); f.reject();
 await expect(f.boundary.run(operation('one'),'browser',()=>f.session.sendMessage('first'))).rejects.toMatchObject({code:'agent_busy'});
 expect(f.contexts.read('handoff').state).toBe('pending');
 await expect(f.boundary.run({...operation('cmd'),kind:'execute_command'},'browser',()=>f.session.executeCommand!('run',''))).rejects.toThrow(/context/i);
 f.supersede(); await expect(f.session.setSessionSetting!('model','new')).rejects.toThrow(/superseded/i);
 expect(f.messages).toEqual([]);
});
test('retains first-input deduplication after materialization while subsequent input uses ordinary settlement',async()=>{
 const f=await fixture(); await f.boundary.run(operation('one'),'browser',()=>f.session.sendMessage('first'));
 const delivery=f.contexts.read('handoff').deliveries[0]!;
 await f.contexts.reconcile('handoff',{operationId:delivery.operationId,target:ref('B'),roleRevision:2,outcome:'materialized',nativeEvidence:'native-user-message-id'});
 await f.boundary.run(operation('one'),'browser',()=>f.session.sendMessage('first'));
 await f.boundary.run(operation('two'),'browser',()=>f.session.sendMessage('second'));
 expect(f.messages).toHaveLength(2); expect(f.messages[1]).toBe('second');
});

test('persists queued acceptance and returns it on duplicate operation after restart', async () => {
 const f = await fixture(); let calls = 0;
 const native = { async sendMessage() { calls++; return { disposition: 'queued' as const }; } } as unknown as AgentSession;
 const session = f.boundary.wrap(ref('B'), native);
 expect(await f.boundary.run(operation('queue'), 'browser', () => session.sendMessage('first'))).toEqual({ disposition: 'queued' });
 expect(await f.boundary.run(operation('queue'), 'browser', () => session.sendMessage('first'))).toEqual({ disposition: 'queued' });
 const restored = new SessionSuccessionContextStore(f.root); await restored.ready;
 const boundary = new SessionSuccessionBoundary(restored, () => {}, () => ({roleId:'role',roleRevision:2}));
 expect(await boundary.run(operation('queue'), 'browser', () => boundary.wrap(ref('B'), native).sendMessage('first'))).toEqual({ disposition: 'queued' });
 expect(calls).toBe(1); expect(restored.read('handoff').state).toBe('accepted');
});
test('rejects unresolved subsequent input explicitly before invoking the native session', async () => {
 const f = await fixture(); await f.boundary.run(operation('one'), 'browser', () => f.session.sendMessage('first'));
 await expect(f.boundary.run(operation('two'), 'browser', () => f.session.sendMessage('second'))).rejects.toBeInstanceOf(AgentOperationRejectedError);
 expect(f.messages).toHaveLength(1);
});

test.each(['started', 'handled'] as const)('preserves actual %s native acceptance without inventing a receipt', async disposition => {
 const f = await fixture();
 const session = f.boundary.wrap(ref('B'), { async sendMessage() { return { disposition }; } } as unknown as AgentSession);
 expect(await f.boundary.run(operation('receipt'), 'browser', () => session.sendMessage('first'))).toEqual({ disposition });
 expect(await f.boundary.run(operation('receipt'), 'browser', () => session.sendMessage('first'))).toEqual({ disposition });
});
test('keeps native exceptions unknown while subsequent input rejection is definitive', async () => {
 const f = await fixture();
 const session = f.boundary.wrap(ref('B'), { async sendMessage() { throw new Error('lost native response'); } } as unknown as AgentSession);
 await expect(f.boundary.run(operation('first'), 'browser', () => session.sendMessage('first'))).rejects.toThrow('lost native response');
 expect(f.contexts.read('handoff').state).toBe('unknown');
 await expect(f.boundary.run(operation('other'), 'browser', () => session.sendMessage('second'))).rejects.toBeInstanceOf(AgentOperationRejectedError);
 expect(f.contexts.read('handoff').deliveries).toHaveLength(1);
});

test('counts directory work until completion and rejects stale source metadata mutations', async () => {
 const f=await fixture(); let finish!:()=>void;
 const gate=new Promise<void>(resolve=>{finish=resolve;});
 const work=f.boundary.mutate(ref('B'),()=>gate);
 expect(f.boundary.pending(ref('B'))).toBe(1);
 finish(); await work;
 expect(f.boundary.pending(ref('B'))).toBe(0);
 f.supersede();
 await expect(f.boundary.mutate(ref('B'),async()=>{f.messages.push('rename');})).rejects.toBeInstanceOf(AgentOperationRejectedError);
 expect(f.messages).toEqual([]);
});

test.each([['void', false], ['queued', false], ['started', false], ['handled', false], ['typed', false], ['unknown', false], ['unknown', true]] as const)('prepared first input keeps original entry accounting for %s (closed %s)', async (outcome, closed) => {
  const f = await fixture(); let prepares = 0, dispatches = 0; const effects: string[] = [], notifications: AgentInputAcceptance[] = []; let saved: AgentPreparedTextInput | undefined;
  const evidence = {
    availability: () => ({ status: 'configured' as const, version: 2 as const }),
    async prepareInput(parts, options) {
      prepares++; expect(parts).toHaveLength(1); expect(parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('source work') });
      expect(options).toEqual({ delivery: 'immediate' });
      const text = (parts[0] as {text:string}).text;
      return { version: 2, providerId: 'fixture', nativeSessionId: 'B', inputId: `U-${prepares}`, cwd: f.root,
        authority: { kind: 'trusted-service' as const, authorityId: 'authority', namespaceId: 'store' }, parts: [{ type: 'text', text }],
        content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') },
        selections: { model: 'provider/model', agent: 'agent', delivery: options?.delivery } } as AgentPreparedTextInput;
    },
    async dispatchInput(witness) {
      dispatches++; saved = witness;
      expect(f.contexts.read('handoff').deliveries[0]?.preparedInput?.witness).toEqual(witness);
      expect(effects).toEqual(['start']);
      if (outcome === 'typed') throw new AgentOperationRejectedError('native_evidence_stale', 'stale');
      if (outcome === 'unknown') throw new Error('lost response');
      return outcome === 'void' ? undefined : { disposition: outcome } as AgentInputAcceptance;
    },
  } as AgentSessionNativeEvidence;
  const session = f.boundary.wrap(ref('B'), { nativeEvidence: evidence, async sendMessage() { throw new Error('ordinary send bypass'); } } as unknown as AgentSession);
  const entry: MutationEntry = { key: 'original', targets: [nativeSessionRefKey(ref('B'))],
    startNativeEffect(target) { expect(target).toBe(nativeSessionRefKey(ref('B'))); return { settled() { effects.push('settled'); }, unresolved() { effects.push('unresolved'); } }; },
    retainAsyncWork() { throw new Error('unexpected retained work'); }, reserveNativeEffect() { throw new Error('unexpected reservation'); } };
  const start = entry.startNativeEffect; entry.startNativeEffect = target => { effects.push('start'); return start(target); };
  const send = (text = 'first') => f.boundary.run(operation('first'), 'browser', () => session.sendMessage(text, { delivery: 'immediate', onAcceptance: value => { notifications.push(value); } }), entry);
  if (outcome === 'typed' || outcome === 'unknown') await expect(send()).rejects.toThrow(); else await send();
  expect(effects).toEqual(['start', 'unresolved', ...(['typed', 'started', 'handled'].includes(outcome) ? ['settled'] : [])]);
  expect(dispatches).toBe(1); expect(prepares).toBe(1); expect(saved?.parts[0].text.endsWith('first')).toBe(true);
  expect(notifications).toEqual(['started', 'handled'].includes(outcome) ? [{ disposition: outcome }] : []);
  await f.boundary.run(operation('first'), 'browser', () => session.sendMessage('first', { delivery: 'immediate' }), entry).catch(() => undefined);
  await send().catch(() => undefined); expect(dispatches).toBe(1); expect(prepares).toBe(1);
  await expect(send('changed')).rejects.toThrow(/identity/); expect(prepares).toBe(1);
  if (outcome === 'unknown') {
    const { serializeAgentInputMaterialization, serializeAgentPreparedTextInput } = await import('@orchardworks/agent-provider-sdk');
    if (closed) await f.boundary.close();
    const witness = saved!, { delivery: _delivery, ...selections } = witness.selections;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const proof = { version: 2 as const, providerId: witness.providerId, nativeSessionId: witness.nativeSessionId, inputId: witness.inputId, nativeInputId: witness.inputId,
      cwd: witness.cwd, authority: witness.authority, witnessSha256: hash(serializeAgentPreparedTextInput(witness)), contentSha256: witness.content.sha256, nativeSelectionsSha256: hash(JSON.stringify(selections)) };
    const delivery = f.contexts.read('handoff').deliveries[0]!;
    const evidence = { operationId: delivery.operationId, target: ref('B'), roleRevision: 2, outcome: 'materialized' as const };
    await f.contexts.reconcile('handoff', { ...evidence, nativeEvidence: serializeAgentInputMaterialization({ status: 'materialized', proof }) });
    expect(effects).toEqual(['start', 'unresolved']); expect(notifications).toEqual([]);
    await f.contexts.reconcile('handoff', { ...evidence, nativeEvidence: serializeAgentInputMaterialization({ status: 'materialized', proof, execution: { disposition: 'started', nativeExecutionId: 'R' } }) });
    expect(effects).toEqual(['start', 'unresolved', ...(closed ? [] : ['settled'])]);
    expect(f.contexts.delivery(delivery.operationId)?.inputAcceptance).toEqual({ disposition: 'started' });
    expect(notifications).toEqual(closed ? [] : [{ disposition: 'started' }]);
    await f.contexts.reconcile('handoff', { ...evidence, nativeEvidence: serializeAgentInputMaterialization({ status: 'materialized', proof, execution: { disposition: 'started', nativeExecutionId: 'R' } }) });
    expect(notifications).toEqual(closed ? [] : [{ disposition: 'started' }]);
    expect(dispatches).toBe(1); expect(prepares).toBe(1);
  }
});

test('optional first input refuses rich and queued selections before preparation or dispatch', async () => {
  const f = await fixture(); let calls = 0;
  const session = f.boundary.wrap(ref('B'), { nativeEvidence: { availability: () => ({ status: 'configured', version: 2 }),
    async prepareInput() { calls++; throw new Error('unexpected prepare'); } }, async sendMessage() { calls++; }, async sendMessageContent() { calls++; } } as unknown as AgentSession);
  await expect(f.boundary.run(operation('image'), 'browser', () => session.sendMessageContent!([{ type: 'image', bytes: new Uint8Array([1]), mediaType: 'image/png' }]))).rejects.toBeInstanceOf(AgentOperationRejectedError);
  await expect(f.boundary.run(operation('queue'), 'browser', () => session.sendMessage('later', { delivery: 'next_turn' }))).rejects.toBeInstanceOf(AgentOperationRejectedError);
  expect(calls).toBe(0); expect(f.contexts.read('handoff').deliveries).toEqual([]);
});

test('direct nested dispatch requires the original admitted entry while prepare and inspect are not effects', async () => {
  const f=await fixture(),calls:string[]=[],target=ref('ordinary');
  const evidence=Object.freeze({async prepareInput(){calls.push('prepare');return {};},async inspectInput(){calls.push('inspect');return {};},async dispatchInput(){calls.push('dispatch');}});
  const session=f.boundary.wrap(target,{nativeEvidence:evidence} as unknown as AgentSession);
  await session.nativeEvidence!.prepareInput([]);await session.nativeEvidence!.inspectInput({} as never);
  await expect(session.nativeEvidence!.dispatchInput({} as never)).rejects.toBeInstanceOf(AgentOperationRejectedError);
  expect(calls).toEqual(['prepare','inspect']);
  const entry={key:'original',targets:[nativeSessionRefKey(target)],startNativeEffect(key:string){
    expect(key).toBe(nativeSessionRefKey(target));calls.push('effect');
    return {settled(){calls.push('settled');},unresolved(){calls.push('unresolved');}};
  }} as MutationEntry;
  await f.boundary.run(operation('direct'),'browser',()=>session.nativeEvidence!.dispatchInput({} as never),entry);
  expect(calls).toEqual(['prepare','inspect','effect','dispatch','unresolved']);
  await expect(f.boundary.run(operation('wrong'),'browser',()=>session.nativeEvidence!.dispatchInput({} as never),{...entry,targets:[nativeSessionRefKey(ref('wrong'))]})).rejects.toThrow(/target/i);
  expect(calls).toHaveLength(5);
});


test('pins the first ordinary ARC input and its late acceptance settles only the original effect', async () => {
  const f = await fixture(); let now = 1000; const cache = createOperationCache({ ttlMs: 10, now: () => now });
  const boundary = new SessionSuccessionBoundary(f.contexts, () => {}, () => undefined, cache);
  const target = ref('ordinary'), key = nativeSessionRefKey(target); let notify: ((value: AgentInputAcceptance) => void) | undefined;
  const session = boundary.wrap(target, { async sendMessage(_text, options) {
    const restored = new SessionSuccessionContextStore(f.root); await restored.ready;
    expect(restored.coverageAvailable(target)).toBe(false);
    notify = options?.onAcceptance;
  } } as AgentSession);
  const op = operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await cache.execute({ operationId: op.operationId, scope: 'browser', kind: op.kind, target: key, parameters: op.parameters }, {
    mutationTargets: [key], admit: entry => boundary.admit([target], entry.key),
    run: (entry, work) => boundary.run(op, 'browser', work, entry), dispatch: () => session.sendMessage('hello'),
  });
  now += 100; expect(cache.hasUnsettledMutation(key)).toBe(true); expect(() => boundary.checkSource(target)).toThrow(/unsettled/i);
  notify!({ disposition: 'queued' }); expect(cache.hasUnsettledMutation(key)).toBe(true);
  notify!({ disposition: 'started' }); expect(cache.hasUnsettledMutation(key)).toBe(false);
  await boundary.reconcileCoverage(target);
  const restored = new SessionSuccessionContextStore(f.root); await restored.ready; expect(restored.coverageAvailable(target)).toBe(true);
  boundary.checkSource(target); await boundary.close(); await cache.close();
});

test('close retains a failed coverage publication and returns the same rejection on repeated close', async () => {
  const f = await fixture(), cache = createOperationCache();
  const boundary = new SessionSuccessionBoundary(f.contexts, () => {}, () => undefined, cache);
  const target = ref('ordinary'), key = nativeSessionRefKey(target), op = operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const failure = new Error('Coverage publication failed');
  const clearing = vi.spyOn(f.contexts, 'clearMutation').mockRejectedValue(failure);
  try {
    await cache.execute({ operationId: op.operationId, scope: 'browser', kind: op.kind, target: key, parameters: op.parameters }, {
      mutationTargets: [key], admit: entry => boundary.admit([target], entry.key),
      run: (entry, work) => boundary.run(op, 'browser', work, entry), dispatch: async () => undefined,
    });
    expect(clearing).toHaveBeenCalledWith(target, expect.any(Function));
    const closing = boundary.close(); expect(boundary.close()).toBe(closing);
    await expect(closing).rejects.toBe(failure);
    const restored = new SessionSuccessionContextStore(f.root); await restored.ready;
    expect(restored.coverageAvailable(target)).toBe(false);
  } finally { clearing.mockRestore(); await boundary.close().catch(() => undefined); await cache.close(); }
});

test('close drains direct coverage reconciliation and rejects new reconciliation after shutdown begins', async () => {
  const f = await fixture(), target = ref('ordinary');
  await f.contexts.markMutation(target, 'mutation');
  const clear = f.contexts.clearMutation.bind(f.contexts);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(f.contexts, 'clearMutation').mockImplementation(async (...args) => { await gate; return clear(...args); });
  const reconciliation = f.boundary.reconcileCoverage(target), closing = f.boundary.close();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const phase = await Promise.race([
      closing.then(() => 'closed'),
      new Promise<string>(resolve => { deadline = setTimeout(() => resolve('draining'), 100); }),
    ]);
    expect(phase).toBe('draining');
    await expect(f.boundary.reconcileCoverage(target)).rejects.toThrow(/closing/i);
    release(); await reconciliation; await closing;
    const restored = new SessionSuccessionContextStore(f.root); await restored.ready;
    expect(restored.coverageAvailable(target)).toBe(true);
  } finally { if (deadline) clearTimeout(deadline); release(); await reconciliation; await closing; spy.mockRestore(); }
});

async function recoveryFixture() {
 const f = await fixture(); let confirmed = 'high';
 const boundary = new SessionSuccessionBoundary(f.contexts, () => {}, () => ({roleId:'role',roleRevision:2}), undefined, undefined, undefined, () => true);
 const info = () => ({providerId:'fixture',sessionId:'B',status:'idle' as const,persistence:{providerId:'fixture',sessionId:'B',opaque:JSON.stringify({effort:confirmed})}});
 const native = { async runtimeInfo() {return info();}, async setSessionSetting(_id:string,value:string) {confirmed=value;},
   async *observe() { yield {type:'observation' as const,sourceKey:'late',occurredAt:1,delivery:'live' as const,event:{type:'runtime_updated' as const,provider:'fixture',runtimeInfo:{...info(),persistence:{providerId:'fixture',sessionId:'B',opaque:'stale'}}}}; }
 } as unknown as AgentSession;
 return {...f,boundary,native,session:boundary.wrap(ref('B'),native),setConfirmed:(value:string)=>{confirmed=value;}};
}
test('saves confirmed successor settings after first input and refreshes delayed runtime events from the current adapter', async () => {
 const f = await recoveryFixture();
 await f.contexts.begin('handoff',{operationId:'input',roleId:'role',roleRevision:2,target:ref('B'),text:'first'});
 await f.contexts.settle('handoff','input','accepted');
 await f.contexts.reconcile('handoff',{operationId:'input',target:ref('B'),roleRevision:2,outcome:'materialized',nativeEvidence:'native-U'});
 await f.session.setSessionSetting!('reasoning_effort','medium');
 expect(f.contexts.read('handoff').resumeHandle?.opaque).toBe('{"effort":"medium"}');
 f.setConfirmed('low');
 for await (const _ of f.session.observe()) { /* Consume the existing native observation. */ }
 const cold = new SessionSuccessionContextStore(f.root); await cold.ready;
 expect(cold.read('handoff').resumeHandle?.opaque).toBe('{"effort":"low"}');
 expect(cold.canInitializeEmpty(ref('B'))).toBe(false);
 await f.boundary.close();
});
test('reserves recovery configuration before native settings and preserves post-effect persistence failure as unknown', async () => {
 const f = await recoveryFixture(), setter = vi.spyOn(f.native,'setSessionSetting');
 const reserve = vi.spyOn(f.contexts,'reserveResumeHandle').mockRejectedValueOnce(new Error('capacity'));
 await expect(f.session.setSessionSetting!('reasoning_effort','medium')).rejects.toBeInstanceOf(AgentOperationRejectedError);
 expect(setter).not.toHaveBeenCalled(); reserve.mockRestore();
 vi.spyOn(f.contexts,'retainResumeHandle').mockRejectedValueOnce(new Error('disk failure'));
 let failure:unknown;
 try {await f.session.setSessionSetting!('reasoning_effort','medium');} catch(error) {failure=error;}
 expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(AgentOperationRejectedError);
 expect(setter).toHaveBeenCalledTimes(1);
});

test('drains confirmed recovery reads before Host shutdown can release the native directory', async () => {
 const f = await recoveryFixture(); let release!:()=>void, entered!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{entered=resolve;});
 const original=f.native.runtimeInfo.bind(f.native);
 vi.spyOn(f.native,'runtimeInfo').mockImplementationOnce(async()=>{entered();await blocked;return original();});
 const reading=f.session.runtimeInfo();await started;
 let closed=false;const closing=f.boundary.close().then(()=>{closed=true;});
 await new Promise<void>(resolve=>setTimeout(resolve,10));expect(closed).toBe(false);
 release();await reading;await closing;
 const cold=new SessionSuccessionContextStore(f.root);await cold.ready;
 expect(cold.read('handoff').resumeHandle?.opaque).toBe('{"effort":"high"}');
});

test('retains native readback even when a requested setting is refused', async () => {
 const f=await recoveryFixture();
 vi.spyOn(f.native,'setSessionSetting').mockImplementationOnce(async()=>{f.setConfirmed('low');throw new AgentOperationRejectedError('operation_rejected','Applied low instead');});
 await expect(f.session.setSessionSetting!('reasoning_effort','max')).rejects.toBeInstanceOf(AgentOperationRejectedError);
 expect(f.contexts.read('handoff').resumeHandle?.opaque).toBe('{"effort":"low"}');
 await f.boundary.close();
});
test('drains an admitted setter and its final readback during shutdown', async () => {
 const f=await recoveryFixture();let entered!:()=>void, release!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{entered=resolve;});
 vi.spyOn(f.native,'setSessionSetting').mockImplementationOnce(async()=>{entered();await blocked;f.setConfirmed('medium');});
 const setting=f.session.setSessionSetting!('reasoning_effort','medium');await started;
 let closed=false;const closing=f.boundary.close().then(()=>{closed=true;});
 await new Promise<void>(resolve=>setTimeout(resolve,10));expect(closed).toBe(false);
 await expect(f.session.setSessionSetting!('reasoning_effort','low')).rejects.toThrow(/closing/);
 release();await setting;await closing;
 const cold=new SessionSuccessionContextStore(f.root);await cold.ready;
 expect(cold.read('handoff').resumeHandle?.opaque).toBe('{"effort":"medium"}');
});
