import { beforeEach, expect, it, vi } from 'vitest';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseAgentPreparedTextInput, serializeAgentPreparedTextInput } from '@orchardworks/agent-provider-sdk';
const mock = vi.hoisted(() => ({ client: {} as any, native: {} as any, config: {} as any, handler: undefined as any, events: [] as any[] }));
vi.mock('@github/copilot-sdk', () => ({ RuntimeConnection: {forStdio: (value: unknown) => value}, CopilotClient: class {constructor() {return mock.client;}} }));
import { CopilotAgentProvider } from './provider.js';

beforeEach(() => {
  mock.events = []; mock.handler = undefined;
  mock.native = {on: vi.fn((handler: unknown) => {mock.handler = handler; return vi.fn();}), getEvents: vi.fn(async () => structuredClone(mock.events)),
    send: vi.fn(async () => 'native-message-1'), disconnect: vi.fn(async () => {}), rpc: {
      metadata: {isProcessing: vi.fn(async () => ({processing:false})), snapshot: vi.fn(async () => ({sessionId:mock.config.sessionId, workingDirectory:mock.config.workingDirectory})), contextInfo: async () => ({contextInfo:null})},
      model: {getCurrent:vi.fn(async () => ({modelId:'native-model', reasoningEffort:'high'})), list:async () => ({list:[]})},
      agent: {getCurrent: async () => ({agent:null})},
      mode: {get:vi.fn(async () => 'interactive'), set:vi.fn(async () => {})},
      queue: {pendingItems:vi.fn(async () => ({items:[],steeringMessages:[],inFlightSteeringCount:0}))},
      permissions: {setApproveAll: async () => ({success:true}), configure:async () => ({success:true}), pendingRequests:vi.fn(async () => ({items:[]}))},
      tasks: {list:vi.fn(async () => ({tasks:[]}))}, skills:{ensureLoaded:async () => {},list:async () => ({skills:[]})},
      plan:{readSqlTodos:async () => ({rows:[]})}, usage:{getMetrics:async () => ({})},
    }};
  mock.client = {start:async () => {},stop:async () => [],forceStop:async () => {},
    createSession:vi.fn(async (config: any) => {mock.config=config; return mock.native;}),
    resumeSession:vi.fn(async (id: string,config: any) => {mock.config={...config,sessionId:id}; return mock.native;}),
    getSessionMetadata:vi.fn(async () => undefined),listSessions:async () => [],
    rpc:{sessions:{checkInUse:async () => ({inUse:[]})},skills:{getDiscoveryPaths:async () => ({paths:[]})}}};
});
function provider(namespace = '/isolated/copilot-profile', requestTimeoutMs = 500, executable = '/isolated/copilot') {return new CopilotAgentProvider({executable,env:{COPILOT_HOME:namespace},requestTimeoutMs});}
async function opened(timeout?:number) {const p=provider(undefined,timeout);const s=await p.createSession({sessionId:'public',cwd:process.cwd()});return {p,s,e:s.nativeEvidence!};}
function event(type:string,data:unknown,id:string,extra={}) {return {type,data,id,parentId:null,timestamp:new Date().toISOString(),...extra};}
function deliver(value:any) {mock.events.push(value);mock.handler(value);}
function input(messageId='native-message-1',text='exact') {return event('user.message',{content:text,messageId,interactionId:'interaction-1',delivery:'idle'},'user-record-1');}
function start(extra={}) {return event('assistant.turn_start',{interactionId:'interaction-1',turnId:'0'},'execution-record-1',extra);}

it('accepts the role an empty successor takes over and leaves it to the attachment',async () => {
  const p=provider();
  try {
    const role={instructions:'Team role',tools:[{name:'read_team',description:'Read the Team',inputSchema:{type:'object'},execute:async()=>'unbound'}]};
    const created=await p.nativeEvidence!.createEmpty({sessionId:'successor',cwd:process.cwd(),extensions:role});
    expect(created.status).toBe('created');
    await expect(p.nativeEvidence!.createEmpty({sessionId:'other',cwd:process.cwd(),unknown:true} as never)).rejects.toThrow();
  } finally {await p.dispose();}
});

it('retains a bounded empty descriptor and only initializes a missing native session with explicit permission',async () => {
  const p=provider();
  try {
    expect(p.nativeEvidence).toBeDefined();
    const created=await p.nativeEvidence!.createEmpty({sessionId:'successor',cwd:process.cwd()});
    expect(created.status).toBe('created'); if(created.status!=='created') throw new Error('Missing descriptor');
    expect(created.handle.sessionId).toBe('successor');expect(mock.native.send).not.toHaveBeenCalled();
    expect(await p.sessionWorkspace('successor',created.handle)).toBe(await realpath(process.cwd()));
    mock.client.resumeSession.mockRejectedValue(new Error('Session not found: successor'));
    const creations=mock.client.createSession.mock.calls.length;
    await expect(p.resumeSession(created.handle)).rejects.toThrow(/Session not found/);
    expect(mock.client.createSession).toHaveBeenCalledTimes(creations);
    mock.client.resumeSession.mockRejectedValueOnce(new Error('Permission failure: Session not found: successor'));
    await expect(p.resumeSession(created.handle,{}, {initializeEmpty:true})).rejects.toThrow(/Permission failure/);
    expect(mock.client.createSession).toHaveBeenCalledTimes(creations);
    mock.client.resumeSession.mockRejectedValueOnce(new Error('Request session.resume failed with message: Failed to load session events: Session not found: successor'));
    const session=await p.resumeSession(created.handle,{}, {initializeEmpty:true});
    expect((await session.runtimeInfo()).sessionId).toBe('successor');
    expect(mock.config).toMatchObject({sessionId:'successor',model:'native-model',reasoningEffort:'high'});
    expect(mock.native.send).not.toHaveBeenCalled();await session.dispose();
    const other=provider('/different-profile');
    try {await expect(other.resumeSession(created.handle,{}, {initializeEmpty:true})).rejects.toThrow();}
    finally {await other.dispose();}
  } finally {await p.dispose();}
},10000);

it('keys prepared sessions by native profile, independent of the CLI version path and service endpoint',async () => {
  const first=new CopilotAgentProvider({executable:'/version/one/copilot',env:{COPILOT_HOME:undefined,HOME:'/isolated/home-one'},nativeSessionConfig:{provider:{type:'openai',baseUrl:'http://localhost:1111'}}});
  try {
    const result=await first.nativeEvidence!.createEmpty({sessionId:'successor',cwd:process.cwd()});
    if(result.status!=='created') throw new Error('Missing descriptor');
    const sameProfile=new CopilotAgentProvider({executable:'/version/two/copilot',env:{COPILOT_HOME:undefined,HOME:'/isolated/home-one'},nativeSessionConfig:{provider:{type:'openai',baseUrl:'http://localhost:2222'}}});
    try {expect((await sameProfile.resumeSession(result.handle)).nativeEvidence!.availability()).toMatchObject({status:'configured'});}
    finally {await sameProfile.dispose();}
    const otherProfile=new CopilotAgentProvider({executable:'/version/two/copilot',env:{COPILOT_HOME:undefined,HOME:'/isolated/home-two'}});
    try {await expect(otherProfile.resumeSession(result.handle)).rejects.toMatchObject({code:'native_evidence_stale'});}
    finally {await otherProfile.dispose();}
  } finally {await first.dispose();}
},10000);

it('reads native readiness and rejects stale snapshots and old attachment tokens',async () => {
  const {p,s,e}=await opened();
  try {
    expect(e).toBeDefined();
    expect(await e.inspectReadiness()).toEqual({cwd:await realpath(process.cwd()),idle:true,pendingInputs:0,pendingInteractions:0,activeChildren:0});
    const token=e.captureValidity();expect(e.isCurrent(token)).toBe(true);
    mock.native.rpc.queue.pendingItems.mockResolvedValue({items:[{id:'queued'}],steeringMessages:['steer'],inFlightSteeringCount:1});
    mock.native.rpc.permissions.pendingRequests.mockResolvedValue({items:[{requestId:'permission'}]});
    mock.native.rpc.tasks.list.mockResolvedValue({tasks:[{type:'agent',id:'child',status:'running'},{type:'shell',id:'shell',status:'running'},{type:'agent',id:'done',status:'completed'}]});
    expect(await e.inspectReadiness()).toMatchObject({pendingInputs:3,pendingInteractions:1,activeChildren:2});
    expect(e.isCurrent(token)).toBe(false);
    let release!:(v:unknown)=>void;
    mock.native.rpc.metadata.isProcessing.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const reading=e.inspectReadiness();await vi.waitFor(()=>expect(release).toBeDefined());deliver(start());release({processing:false});
    await expect(reading).rejects.toMatchObject({code:'native_evidence_stale'});
    await s.dispose();expect(e.isCurrent(token)).toBe(false);
  } finally {await p.dispose();}
},10000);

it('correlates only the acknowledged native user record and its own execution',async () => {
  const {p,e}=await opened();
  try {
    expect(e).toBeDefined();await e.inspectReadiness();
    const witness=await e.prepareInput([{type:'text',text:'exact'}]);
    expect(witness.inputId).toBeTypeOf('string');expect((witness as any).nativeInputId).toBeUndefined();
    await e.dispatchInput(witness);
    deliver(input('other-message'));
    expect(await e.inspectInput(witness)).toMatchObject({status:'unknown'});
    mock.events=[];deliver(input());
    expect(await e.inspectInput(witness)).toMatchObject({status:'materialized',proof:{inputId:witness.inputId,nativeInputId:'user-record-1'}});
    const {delivery:_delivery,...selections}=parseAgentPreparedTextInput(serializeAgentPreparedTextInput(witness)).selections;
    expect(await e.inspectInput(witness)).toMatchObject({proof:{nativeSelectionsSha256:createHash('sha256').update(JSON.stringify(selections)).digest('hex')}});
    expect((await e.inspectInput(witness)) as any).not.toHaveProperty('execution');
    deliver(start({agentId:'child'}));expect((await e.inspectInput(witness)) as any).not.toHaveProperty('execution');
    deliver(start());expect(await e.inspectInput(witness)).toMatchObject({status:'materialized',execution:{disposition:'started',nativeExecutionId:'execution-record-1'}});
    await expect(e.dispatchInput(witness)).rejects.toThrow();expect(mock.native.send).toHaveBeenCalledTimes(1);
  } finally {await p.dispose();}
},10000);

it('retains a late native acknowledgement without replaying an uncertain input',async () => {
  const {p,e}=await opened(30);
  try {
    expect(e).toBeDefined();await e.inspectReadiness();const witness=await e.prepareInput([{type:'text',text:'exact'}]);
    let finish!:(id:string)=>void;mock.native.send.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await expect(e.dispatchInput(witness)).rejects.toMatchObject({code:'native_evidence_outcome_unknown'});
    await expect(e.inspectReadiness()).rejects.toMatchObject({code:'native_evidence_stale'});
    deliver(input());deliver(start());expect(await e.inspectInput(witness)).toMatchObject({status:'unknown'});
    finish('native-message-1');await Promise.resolve();
    expect(await e.inspectInput(witness)).toMatchObject({status:'materialized',execution:{disposition:'started'}});
    await expect(e.dispatchInput(witness)).rejects.toThrow();expect(mock.native.send).toHaveBeenCalledTimes(1);
  } finally {await p.dispose();}
},10000);

it('keeps admission closed after an ordinary native input times out until that invocation settles',async () => {
  const {p,s,e}=await opened(30);
  try {
    await e.inspectReadiness();const token=e.captureValidity();
    let finish!:(id:string)=>void;mock.native.send.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    await expect(s.sendMessage('ordinary')).rejects.toThrow(/timed out/i);
    expect(e.isCurrent(token)).toBe(false);
    await expect(e.inspectReadiness()).rejects.toMatchObject({code:'native_evidence_stale'});
    finish('ordinary-message');await Promise.resolve();
    expect(await e.inspectReadiness()).toMatchObject({idle:true});
  } finally {await p.dispose();}
},10000);

it('does not dispatch a prepared input after its confirmed permission selection changes',async () => {
  const {p,s,e}=await opened();
  try {
    const witness=await e.prepareInput([{type:'text',text:'exact'}]);
    await s.setSessionSetting('tool_approval_mode','allow');
    await expect(e.dispatchInput(witness)).rejects.toMatchObject({code:'native_evidence_admission'});
    expect(mock.native.send).not.toHaveBeenCalled();
  } finally {await p.dispose();}
},10000);

it.each(['abort','session.compaction_start','session.snapshot_rewind','assistant.message'])('invalidates readiness when native %s changes the source context',async type => {
  const {p,e}=await opened();
  try {
    await e.inspectReadiness();const token=e.captureValidity();
    deliver(event(type,{content:'native change'},'context-change'));
    expect(e.isCurrent(token)).toBe(false);
  } finally {await p.dispose();}
},10000);

it('retains confirmed pre-input changes but never applies creation settings over existing native history',async () => {
  const p=provider();
  try {
    const result=await p.nativeEvidence!.createEmpty({sessionId:'successor',cwd:process.cwd()});
    if(result.status!=='created') throw new Error('Missing descriptor');
    mock.client.resumeSession.mockRejectedValueOnce(new Error('Session not found: successor'));
    const empty=await p.resumeSession(result.handle,{}, {initializeEmpty:true});
    await empty.setSessionSetting('tool_approval_mode','allow');
    deliver(event('session.mode_changed',{newMode:'plan'},'mode-change'));
    const latest=(await empty.runtimeInfo()).persistence!;
    expect(JSON.parse(latest.opaque).selections).toMatchObject({mode:'plan',toolApproval:'allow'});
    await empty.dispose();
    mock.native.rpc.model.getCurrent.mockResolvedValue({modelId:'newer-native-model'});
    mock.native.rpc.mode.get.mockResolvedValue('autopilot');
    const oldSwitches=mock.native.rpc.mode.set.mock.calls.length;
    const recovered=await p.resumeSession(result.handle,{}, {initializeEmpty:true});
    expect(mock.config).toMatchObject({model:undefined,reasoningEffort:undefined});
    expect(mock.native.rpc.mode.set).toHaveBeenCalledTimes(oldSwitches);
    expect(JSON.parse((await recovered.runtimeInfo()).persistence!.opaque).selections).toMatchObject({model:'newer-native-model',mode:'autopilot'});
  } finally {await p.dispose();}
},10000);

it('does not reconstruct a lost acknowledgement from matching text after a cold attachment',async () => {
  const {p,s,e}=await opened();
  try {
    expect(e).toBeDefined();await e.inspectReadiness();const witness=await e.prepareInput([{type:'text',text:'exact'}]);await e.dispatchInput(witness);
    const handle=(await s.runtimeInfo()).persistence!;deliver(input());deliver(start());await s.dispose();
    const resumed=await p.resumeSession(handle);
    expect(await resumed.nativeEvidence!.inspectInput(witness)).toMatchObject({status:'unknown'});
    expect(mock.native.send).toHaveBeenCalledTimes(1);await resumed.dispose();
  } finally {await p.dispose();}
},10000);
