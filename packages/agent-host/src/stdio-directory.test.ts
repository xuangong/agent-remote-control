import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import type {AgentSession} from '@orchardworks/agent-provider-sdk';
import {createManagedStdioDirectory} from './stdio-directory.js';
import {acquireNativeSession, inspectNativeOwner} from './native-session-owner.js';

it.each(['claude', 'copilot'])('retains the %s lease when native shutdown fails', async providerId => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-close-'));
  let failed = true;
  const native: AgentSession = {
    capabilities: {history:true, sendMessage:true, steer:false, cancel:false, readResource:false, interactions:{question:false,planApproval:false,toolApproval:false}},
    async *observe() {yield {type:'history_boundary'};},
    async runtimeInfo() {return {providerId, sessionId:'session', status:'idle', persistence:{providerId,sessionId:'session',opaque:'{}'}};},
    async sendMessage() {}, async respondToInteraction() {},
    async dispose() {if (failed) throw new Error('Native exit unconfirmed');},
  };
  const directory = createManagedStdioDirectory(providerId, providerId, {listSessions:async()=>[], createSession:async()=>native, resumeSession:async()=>native}, [], {root});
  const session = await directory.open('session');
  const key = {root, providerId, sessionId:'session'};
  try {
    await expect(directory.close()).rejects.toThrow(/shutdown/);
    expect(await inspectNativeOwner(key)).toMatchObject({kind:'controller'});
    await expect(acquireNativeSession({...key,kind:'native_cli'})).rejects.toMatchObject({code:'native_session_owned'});
  } finally {failed=false; await session.dispose(); await rm(root,{recursive:true,force:true});}
}, 10000);

it('preserves the latest persistence settings when returning from a managed CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-stdio-settings-'));
  const key = {root,providerId:'claude',sessionId:'session'};
  let opaque='initial'; const resumed:string[]=[];
  const native = (): AgentSession => ({
    capabilities:{history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,planApproval:false,toolApproval:false}},
    async *observe(){yield {type:'history_boundary'};},
    async runtimeInfo(){return {providerId:'claude',sessionId:'session',status:'idle',persistence:{providerId:'claude',sessionId:'session',opaque}};},
    async sendMessage(){}, async respondToInteraction(){}, async dispose(){},
  });
  const directory=createManagedStdioDirectory('claude','Claude',{listSessions:async()=>[],createSession:async()=>native(),
    resumeSession:async handle=>{resumed.push(handle.opaque);return native();},releaseSession:async()=>{}},[],{root});
  let cli:Awaited<ReturnType<typeof acquireNativeSession>>|undefined;
  try {
    await directory.open('session'); opaque='changed-model-and-permissions';
    const prior=await inspectNativeOwner(key);
    cli=await acquireNativeSession({...key,kind:'native_cli',takeOver:prior!.generation});cli.activate(async()=> 'requested');
    await directory.open('session',{takeOver:cli.generation});
    expect(resumed).toEqual(['{}','changed-model-and-permissions']);
  } finally {await cli?.release();await directory.close();await rm(root,{recursive:true,force:true});}
}, 10000);

it('coalesces disposal and fences writes while native shutdown is pending', async () => {
  const root=await mkdtemp(join(tmpdir(),'arc-stdio-dispose-'));
  let finish!:()=>void; const gate=new Promise<void>(resolve=>{finish=resolve;});let disposals=0;
  const native:AgentSession={
    capabilities:{history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,planApproval:false,toolApproval:false}},
    async *observe(){yield {type:'history_boundary'};},
    async runtimeInfo(){return {providerId:'claude',sessionId:'session',status:'idle',persistence:{providerId:'claude',sessionId:'session',opaque:'{}'}};},
    async sendMessage(){}, async respondToInteraction(){}, async dispose(){disposals++;await gate;},
  };
  const directory=createManagedStdioDirectory('claude','Claude',{listSessions:async()=>[],createSession:async()=>native,resumeSession:async()=>native},[],{root});
  const session=await directory.open('session');const first=session.dispose();const second=session.dispose();
  try {
    await expect(session.sendMessage('too late')).rejects.toThrow(/control|closed|ownership/);
    await expect.poll(()=>disposals).toBe(1);
  } finally {finish();await Promise.all([first,second]);await directory.close();await rm(root,{recursive:true,force:true});}
},10000);

it('keeps a failed-start lease until native cleanup succeeds before retrying resume', async () => {
  const root=await mkdtemp(join(tmpdir(),'arc-stdio-start-'));
  const key={root,providerId:'claude',sessionId:'session'};
  let canExit=false, starts=0;
  const native:AgentSession={
    capabilities:{history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,planApproval:false,toolApproval:false}},
    async *observe(){yield {type:'history_boundary'};},
    async runtimeInfo(){return {providerId:'claude',sessionId:'session',status:'idle',persistence:{providerId:'claude',sessionId:'session',opaque:'{}'}};},
    async sendMessage(){},async respondToInteraction(){},async dispose(){},
  };
  const directory=createManagedStdioDirectory('claude','Claude',{listSessions:async()=>[],createSession:async()=>native,
    resumeSession:async()=>{if(++starts===1)throw new Error('Initialization cleanup unconfirmed');return native;},
    cleanupFailedSession:async()=>{if(!canExit)throw new Error('Native still running');}},[],{root});
  try {
    await expect(directory.open('session')).rejects.toThrow();
    expect(await inspectNativeOwner(key)).toMatchObject({kind:'controller'});
    await expect(directory.open('session')).rejects.toThrow(/running/);
    expect(starts).toBe(1);
    canExit=true;await directory.open('session');expect(starts).toBe(2);
  }finally{canExit=true;await directory.close();await rm(root,{recursive:true,force:true});}
},10000);

it('allows explicit recovery after a failed takeover once the old native process exits', async () => {
  const root=await mkdtemp(join(tmpdir(),'arc-stdio-retry-'));
  const key={root,providerId:'claude',sessionId:'session'};let canExit=false;
  const native=():AgentSession=>({
    capabilities:{history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,planApproval:false,toolApproval:false}},
    async *observe(){yield {type:'history_boundary'};},
    async runtimeInfo(){return {providerId:'claude',sessionId:'session',status:'idle',persistence:{providerId:'claude',sessionId:'session',opaque:'{}'}};},
    async sendMessage(){},async respondToInteraction(){},async dispose(){},
  });
  const directory=createManagedStdioDirectory('claude','Claude',{listSessions:async()=>[],createSession:async()=>native(),resumeSession:async()=>native(),
    releaseSession:async()=>{if(!canExit)throw new Error('Exit unconfirmed');}},[],{root});
  try {
    await directory.open('session');const prior=await inspectNativeOwner(key);
    await expect(acquireNativeSession({...key,kind:'native_cli',takeOver:prior!.generation})).rejects.toMatchObject({code:'native_handoff_unknown'});
    canExit=true;const resumed=await directory.open('session',{takeOver:prior!.generation});
    await expect(resumed.sendMessage('after recovery')).resolves.toBeUndefined();
  }finally{canExit=true;await directory.close();await rm(root,{recursive:true,force:true});}
},10000);

it('does not use takeover release when resume rejects an unmanaged writer', async () => {
  let closedExternal=false;
  const root=await mkdtemp(join(tmpdir(),'arc-stdio-external-'));
  const directory=createManagedStdioDirectory('copilot','Copilot',{listSessions:async()=>[],createSession:async()=>{throw new Error('unused');},
    resumeSession:async()=>{throw new Error('Session in use by an external client');},releaseSession:async()=>{closedExternal=true;}},[],{root});
  try {await expect(directory.open('external')).rejects.toThrow(/external/);expect(closedExternal).toBe(false);}
  finally {await directory.close();await rm(root,{recursive:true,force:true});}
},10000);

it.each([false,true])('does not release an in-flight resume lease when the directory closes (previously opened: %s)', async previouslyOpened => {
  const root=await mkdtemp(join(tmpdir(),'arc-stdio-opening-'));
  const key={root,providerId:'claude',sessionId:'session'};
  let resolveStart!:()=>void;const started=new Promise<void>(resolve=>{resolveStart=resolve;});
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});let disposed=false, resumes=0;
  const native:AgentSession={
    capabilities:{history:true,sendMessage:true,steer:false,cancel:false,readResource:false,interactions:{question:false,planApproval:false,toolApproval:false}},
    async *observe(){yield {type:'history_boundary'};},
    async runtimeInfo(){return {providerId:'claude',sessionId:'session',status:disposed?'closed':'idle',persistence:{providerId:'claude',sessionId:'session',opaque:'{}'}};},
    async sendMessage(){},async respondToInteraction(){},async dispose(){disposed=true;},
  };
  const directory=createManagedStdioDirectory('claude','Claude',{listSessions:async()=>[],createSession:async()=>native,
    resumeSession:async()=>{if(previouslyOpened && ++resumes===1)return native;resolveStart();await gate;return native;}},[],{root});
  if(previouslyOpened)await (await directory.open('session')).dispose();
  const opening=directory.open('session');await started;
  try {await directory.close();expect(await inspectNativeOwner(key)).toMatchObject({kind:'controller'});}
  finally {finish();await expect(opening).rejects.toThrow(/closed/);expect(disposed).toBe(true);await rm(root,{recursive:true,force:true});}
},10000);
