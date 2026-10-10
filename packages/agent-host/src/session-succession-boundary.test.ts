import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AgentOperationRejectedError, type AgentInputPart, type AgentSession } from '@orchardworks/agent-provider-sdk';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
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
