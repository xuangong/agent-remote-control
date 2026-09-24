import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, expect, it} from 'vitest';
import {acquireNativeSession, inspectNativeOwner, type NativeSessionLease} from './native-session-owner.js';
const roots: string[] = [], leases: NativeSessionLease[] = [];
afterEach(async () => { await Promise.all(leases.splice(0).map(lease => lease.release())); await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true}))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'arc-owner-')); roots.push(root); return {root, providerId:'fixture', sessionId:'same-session'}; }
async function acquire(input: Parameters<typeof acquireNativeSession>[0]) { const lease = await acquireNativeSession(input); leases.push(lease); return lease; }
it('fences the former writer before closing, transferring only after release confirmation', async () => {
  const f = await fixture(); const events: string[] = [];
  const old = await acquire({...f, kind:'native_cli'});
  let finish!: () => void; const stopped = new Promise<void>(resolve => {finish=resolve;});
  old.activate(async () => {events.push('interrupt'); await stopped; events.push('released'); return 'requested';});
  await expect(acquire({...f, kind:'controller'})).rejects.toMatchObject({code:'native_session_owned', owner:{kind:'native_cli', generation:old.generation}});
  const opening = acquire({...f, kind:'controller', takeOver:old.generation});
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(old.active).toBe(false); expect(events).toEqual(['interrupt']);
  finish(); const next = await opening; next.activate(async () => 'requested');
  expect(events).toEqual(['interrupt','released']); expect(next.active).toBe(true);
  await old.release(); expect((await inspectNativeOwner(f))?.generation).toBe(next.generation);
  await expect(acquire({...f, kind:'native_cli', takeOver:old.generation})).rejects.toMatchObject({code:'native_owner_changed'});
}, 5000);
it('admits one successor and does not stop the winner on competing or stale takeover', async () => {
  const f = await fixture(); const old = await acquire({...f,kind:'controller'}); let stops=0;
  old.activate(async () => {stops++; await new Promise(resolve => setTimeout(resolve, 40)); return 'requested';});
  const results = await Promise.allSettled([acquire({...f,kind:'native_cli',takeOver:old.generation}),acquire({...f,kind:'controller',takeOver:old.generation})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1); expect(stops).toBe(1);
}, 5000);
it('keeps ownership unavailable if native release cannot be confirmed', async () => {
  const f = await fixture(); const old=await acquire({...f,kind:'native_cli'});
  old.activate(async()=> {throw new Error('release not confirmed');});
  await expect(acquire({...f,kind:'controller',takeOver:old.generation})).rejects.toMatchObject({code:'native_handoff_unknown'});
  expect(old.active).toBe(false); expect((await inspectNativeOwner(f))?.generation).toBe(old.generation);
  await expect(acquire({...f,kind:'controller'})).rejects.toMatchObject({code:'native_session_owned'});
}, 5000);
it('records requested and forced transfers without exposing management credentials', async()=> {
  const f=await fixture(); const diagnostics: unknown[]=[];
  const old=await acquire({...f,kind:'native_cli',onDiagnostic:event=>diagnostics.push(event)}); old.activate(async()=> 'forced');
  const next=await acquire({...f,kind:'controller',takeOver:old.generation});
  expect(next.previousOutcome).toBe('forced');
  expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({event:'native_handoff_completed',outcome:'forced'})]));
  expect(JSON.stringify(diagnostics)).not.toMatch(/token|port/);
},5000);

it('rejects unauthenticated loopback takeover without interrupting its owner',async()=>{
  const {readdir,readFile}=await import('node:fs/promises');
  const f=await fixture();let interrupted=false;
  const owner=await acquire({...f,kind:'native_cli'});owner.activate(async()=>{interrupted=true;return 'requested';});
  const files=await readdir(f.root);const record=JSON.parse(await readFile(join(f.root,files[0]!),'utf8'));
  const response=await fetch(`http://127.0.0.1:${record.port}/takeover`,{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});
  expect(response.status).toBe(403);expect(interrupted).toBe(false);expect(owner.active).toBe(true);
},5000);

it('classifies a dead owner as unexpected and reclaims only the ARC reservation',async()=>{
  const {spawn}=await import('node:child_process');const {resolve}=await import('node:path');const {pathToFileURL}=await import('node:url');
  const f=await fixture();const events:unknown[]=[];
  const script=`import {acquireNativeSession} from ${JSON.stringify(pathToFileURL(resolve('dist/native-session-owner.js')).href)}; const lease=await acquireNativeSession(${JSON.stringify({...f,kind:'native_cli'})});lease.activate(async()=> 'requested');console.log('ready');`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  try {
    await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(new Error('Child exited before claiming ownership.')));});
    await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGKILL');});
    const next=await acquire({...f,kind:'controller',onDiagnostic:event=>events.push(event)});
    next.activate(async()=> 'requested');
    expect(events).toContainEqual(expect.objectContaining({event:'native_owner_exited',outcome:'unexpected'}));
  }finally {if(child.exitCode===null)child.kill('SIGKILL');}
},5000);

it('does not strand a successor reservation when release completes after the request deadline',async()=>{
  const f=await fixture();const old=await acquire({...f,kind:'native_cli'});
  old.activate(async()=>{await new Promise(resolve=>setTimeout(resolve,80));return 'requested';});
  await expect(acquire({...f,kind:'controller',takeOver:old.generation,requestTimeoutMs:25})).rejects.toMatchObject({code:'native_handoff_unknown'});
  await new Promise(resolve=>setTimeout(resolve,100));
  const next=await acquire({...f,kind:'controller'});next.activate(async()=> 'requested');expect(next.active).toBe(true);
},5000);
