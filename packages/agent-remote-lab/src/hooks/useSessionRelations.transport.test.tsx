import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';
import { ForkEntries } from '../components/ForkReference.js';
import { useState, useEffect } from 'react';
import { render, unmount } from '../test/setup.js';
import { sideNavigationSource, ForkStore, referenceForkContext } from '../session-forks.js';
import { useSessionRelations } from './useSessionRelations.js';

const source = { hostId: 'host', providerId: 'codex', nativeSessionId: 'main', agentId: 'main-agent', title: 'Main' };
const side: SessionRelation = { id: 'side', kind: 'side', createdAt: '2026-10-02T00:00:00.000Z', source,
  target: { ...source, nativeSessionId: 'side', agentId: 'side-agent', title: 'Side' } };
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  localStorage.clear();
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void): Promise<string> {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(() => { response.writeHead(500).end(); }); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return `http://127.0.0.1:${address.port}/u/alice/`;
}
function reply(response: ServerResponse, relations: SessionRelation[], status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ relations }));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}
async function mount(baseUrl: string, sides = new ForkStore(baseUrl), enabled = true, accountScoped = enabled) {
  let relations!: ReturnType<typeof useSessionRelations>;
  const asks = new ForkStore(baseUrl + 'ask');
  function Harness() { relations = useSessionRelations(baseUrl, enabled, sides, asks, 'main', accountScoped); return null; }
  await render(<Harness />);
  await act(async () => relations());
  return { sides, asks, relations };
}

it('changes only shared navigation through a versioned PATCH and preserves the local first-input ledger', async () => {
  const sides = new ForkStore('shared-unlink-wire');
  const record = sides.prepare(referenceForkContext(source), { sourceNativeSessionId: 'main' });
  sides.bind(record.id, side.target); sides.markConfigured(record.id);
  await sides.send(record.id, 'first question', async () => {}, async () => false);
  let shared: SessionRelation[] = [side];
  const patches: Record<string, unknown>[] = [];
  const baseUrl = await serve(async (request, response) => {
    if (request.method === 'PATCH') {
      patches.push(await body(request));
      shared = [{ ...side, linked: false, revision: 1 }];
    }
    reply(response, shared);
  });
  const { relations } = await mount(baseUrl, sides);
  await act(async () => relations.setLinked(sides.get(record.id), false));
  expect(patches).toEqual([{ hostId: 'host', providerId: 'codex', nativeSessionId: 'side', sourceNativeSessionId: 'main', id: 'side', linked: false, expectedRevision: 0 }]);
  expect(sides.linked()).toEqual([]);
  expect(sides.get(record.id)).toMatchObject({ linked: false, revision: 1, delivery: 'sent', firstInput: 'first question' });
});

it('ignores a GET started before an acknowledged PATCH even when that GET omits the relation', async () => {
  let held: ServerResponse | undefined;
  let holdNext = false;
  let getStarted!: () => void;
  const started = new Promise<void>((resolve) => { getStarted = resolve; });
  let shared: SessionRelation[] = [side];
  const baseUrl = await serve((request, response) => {
    if (request.method === 'GET' && holdNext) { holdNext = false; held = response; getStarted(); return; }
    if (request.method === 'PATCH') shared = [{ ...side, linked: false, revision: 1 }];
    reply(response, shared);
  });
  const { sides, relations } = await mount(baseUrl);
  holdNext = true;
  const staleRefresh = relations();
  void staleRefresh.catch(() => {});
  await started;
  await act(async () => relations.setLinked(sides.get('side'), false));
  reply(held!, []);
  await act(async () => staleRefresh);
  expect(sides.all()).toHaveLength(1);
  expect(sides.get('side')).toMatchObject({ linked: false, revision: 1 });
  expect(sides.linked()).toEqual([]);
});

it('keeps a shared tombstone authoritative instead of reimporting an older browser ledger', async () => {
  const sides = new ForkStore('old-ledger-tombstone');
  const local = sides.prepare(referenceForkContext(source), { sourceNativeSessionId: 'main' });
  sides.bind(local.id, side.target); sides.markConfigured(local.id);
  const methods: string[] = [];
  const baseUrl = await serve((request, response) => {
    methods.push(request.method!);
    reply(response, [{ ...side, linked: false, revision: 2 }]);
  });
  const { relations } = await mount(baseUrl, sides);
  await act(async () => relations());
  expect(methods).not.toContain('POST');
  expect(sides.get(local.id)).toMatchObject({ linked: false, revision: 2, delivery: 'pending' });
  expect(sides.linked()).toEqual([]);
});

it('rejects a stale Undo and exposes the newer shared revision for an explicit retry', async () => {
  let shared: SessionRelation[] = [{ ...side, linked: false, revision: 1 }];
  const baseUrl = await serve(async (request, response) => {
    if (request.method === 'PATCH') {
      const input = await body(request);
      if (input.expectedRevision !== shared[0]!.revision) {
        response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'relation_conflict', message: 'Changed' } }));
        return;
      }
      shared = [{ ...side, linked: input.linked as boolean, revision: shared[0]!.revision! + 1 }];
    }
    reply(response, shared);
  });
  const { sides, relations } = await mount(baseUrl);
  const undo = sides.get('side');
  shared = [{ ...side, linked: false, revision: 3 }];
  await expect(relations.setLinked(undo, true)).rejects.toThrow(/changed/);
  expect(sides.get('side')).toMatchObject({ linked: false, revision: 3 });
  await act(async () => relations.setLinked(sides.get('side'), true));
  expect(sides.linked()).toHaveLength(1);
  expect(sides.get('side').revision).toBe(4);
});

it('reports a lost PATCH receipt as unconfirmed and lets a refresh discover the committed state', async () => {
  let shared: SessionRelation[] = [side];
  const baseUrl = await serve((request, response) => {
    if (request.method === 'PATCH') {
      shared = [{ ...side, linked: false, revision: 1 }];
      response.destroy();
      return;
    }
    reply(response, shared);
  });
  const { sides, relations } = await mount(baseUrl);
  await expect(relations.setLinked(sides.get('side'), false)).rejects.toThrow(/confirm/);
  await act(async () => relations());
  expect(sides.linked()).toEqual([]);
  expect(sides.get('side').revision).toBe(1);
});

it('persists local-mode unlink without a server and keeps Ask read-only for this operation', async () => {
  const sides = new ForkStore('local-relations');
  const record = sides.prepare(referenceForkContext(source), { sourceNativeSessionId: 'main' });
  sides.bind(record.id, side.target);
  const { asks, relations } = await mount('http://localhost/', sides, false);
  await act(async () => relations.setLinked(sides.get(record.id), false));
  expect(new ForkStore('local-relations').get(record.id)).toMatchObject({ linked: false, revision: 1 });
  asks.setSharedRelations([{ ...side, id: 'ask', kind: 'ask', target: { ...side.target, nativeSessionId: 'ask' } }]);
  await expect(relations.setLinked(asks.get('ask'), false)).rejects.toThrow(/side/i);
});

it('does not treat a hosted workspace restoring access as local-mode success', async () => {
  const sides = new ForkStore('restoring-hosted');
  const record = sides.prepare(referenceForkContext(source), { sourceNativeSessionId: 'main' });
  sides.bind(record.id, side.target);
  const { relations } = await mount('http://localhost/', sides, false, true);
  await expect(relations.setLinked(sides.get(record.id), false)).rejects.toThrow(/access is restoring/);
  expect(sides.linked()).toHaveLength(1);
  expect(sides.get(record.id).revision).toBeUndefined();
});

it('does not report a successful unlink when a PATCH response has no authoritative tombstone', async () => {
  const baseUrl = await serve((_request, response) => reply(response, [side]));
  const { sides, relations } = await mount(baseUrl);
  await expect(relations.setLinked(sides.get('side'), false)).rejects.toThrow(/confirm/);
  expect(sides.linked()).toHaveLength(1);
});

it.each([
  { code: 'forbidden', error: 'Workspace permission is required.' },
  { error: { code: 'forbidden', message: 'Workspace permission is required.' } },
])('reports an explicit permission refusal separately from an unknown transport outcome: %j', async (error) => {
  const baseUrl = await serve((request, response) => {
    if (request.method === 'PATCH') {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify(error));
      return;
    }
    reply(response, [side]);
  });
  const { sides, relations } = await mount(baseUrl);
  await expect(relations.setLinked(sides.get('side'), false)).rejects.toThrow('Workspace permission is required.');
  expect(sides.linked()).toHaveLength(1);
});

it('keeps hosted snapshot forks local because they have no shared reference relation', async () => {
  const methods: string[] = [];
  const baseUrl = await serve((request, response) => { methods.push(request.method!); reply(response, []); });
  const sides = new ForkStore(baseUrl);
  const record = sides.prepare({ source, capturedAt: '2026-10-02T00:00:00.000Z', boundary: { epoch: 'one', seq: 2 }, itemCount: 0, text: '[]' });
  sides.bind(record.id, side.target);
  const { relations } = await mount(baseUrl, sides);
  await act(async () => relations.setLinked(sides.get(record.id), false));
  expect(new ForkStore(baseUrl).linked()).toEqual([]);
  expect(methods).not.toContain('PATCH');
});

it('retains a coordinated edit identity across a lost response and remount with a changed displayed provider', async () => {
  const original={controllerId:'controller',providerId:'codex',nativeSessionId:'main'};
  let shared:SessionRelation[]=[{...side,nativeSourceRef:original,sourceBinding:{kind:'primary_role',roleId:'role',origin:original},roleRevision:2,source:{...source,providerId:'claude',nativeSessionId:'B'},hostLocator:{hostId:'host',controllerId:'controller'}}];
  const patches:Record<string,unknown>[]=[];let lost=true;
  const baseUrl=await serve(async(request,response)=>{
    if(request.method==='PATCH'){
      const input=await body(request);patches.push(input);
      if(lost){lost=false;response.destroy();return;}
      shared=[{...shared[0]!,source:source,sourceBinding:{kind:'fixed',source:original},linked:false,revision:1}];
    }
    reply(response,shared);
  });
  const first=await mount(baseUrl);await expect(first.relations.setLinked(first.sides.get('side'),false)).rejects.toThrow(/confirm/);
  const second=await mount(baseUrl,new ForkStore(baseUrl));
  await act(async()=>second.relations.setLinked(second.sides.get('side'),false));
  expect(patches).toHaveLength(2);expect(patches[0]!.operationId).toBeTypeOf('string');expect(patches[1]!.operationId).toBe(patches[0]!.operationId);
  expect(patches[0]).toMatchObject({sourceNativeSessionId:'main',expectedRoleRevision:2});expect(second.sides.get('side')).toMatchObject({linked:false,revision:1,nativeSourceRef:original});
});

it('reconcile clears the pending edit from memory and disk before the next opposite intent',async()=>{
  const nativeSourceRef={controllerId:'controller',providerId:'codex',nativeSessionId:'main'};
  let shared:SessionRelation[]=[{...side,nativeSourceRef,hostLocator:{hostId:'host',controllerId:'controller'},sourceBinding:{kind:'primary_role',roleId:'role',origin:nativeSourceRef},roleRevision:2}];
  let pendingId='',lost=true;const ids:string[]=[];
  const baseUrl=await serve(async(request,response)=>{
    if(request.url!.endsWith('/reconcile')){
      const input=await body(request);expect(input.operationId).toBe(pendingId);
      shared=[{...shared[0]!,linked:false,revision:1,sourceBinding:{kind:'fixed',source:nativeSourceRef},operation:{operationId:pendingId,phase:'committed'}}];
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({relations:shared,operation:{reservation:{operationId:pendingId},phase:'committed'}}));return;
    }
    if(request.method==='PATCH'){
      const input=await body(request);ids.push(input.operationId as string);
      if(lost){lost=false;pendingId=input.operationId as string;response.destroy();return;}
      shared=[{...shared[0]!,linked:true,revision:2,operation:{operationId:input.operationId as string,phase:'committed'}}];
    }
    reply(response,shared);
  });
  const {sides,relations}=await mount(baseUrl);
  await expect(relations.setLinked(sides.get('side'),false)).rejects.toThrow(/confirm/);
  await act(async()=>relations.reconcile(sides.get('side')));
  await act(async()=>relations.setLinked(sides.get('side'),true));
  expect(ids[1]).not.toBe(ids[0]);expect(sides.get('side').linked).toBe(true);
});


it('keeps equal relation IDs independently addressable across providers and Hosts', async () => {
  const origin = {controllerId:'controller',providerId:'codex',nativeSessionId:'main'};
  const shared: SessionRelation[] = [
    {...side,nativeSourceRef:origin,hostLocator:{hostId:'host',controllerId:'controller'},sourceBinding:{kind:'primary_role',roleId:'role',origin},roleRevision:2},
    {...side,target:{...side.target,providerId:'claude'},nativeSourceRef:origin,hostLocator:{hostId:'host',controllerId:'controller'},sourceBinding:{kind:'primary_role',roleId:'role',origin},roleRevision:2},
    {...side,source:{...side.source,hostId:'other'},target:{...side.target,hostId:'other'},nativeSourceRef:{...origin,controllerId:'other-controller'},sourceBinding:{kind:'primary_role',roleId:'other-role',origin:{...origin,controllerId:'other-controller'}},roleRevision:2,hostLocator:{hostId:'other',controllerId:'other-controller'}},
  ];
  const patches:Record<string,unknown>[]=[];
  const baseUrl=await serve(async(request,response)=>{if(request.method==='PATCH'){patches.push(await body(request));response.destroy();return;}reply(response,shared);});
  const first=await mount(baseUrl);
  expect(first.sides.all()).toHaveLength(3);
  for(const record of first.sides.all()) await expect(first.relations.setLinked(record,false)).rejects.toThrow(/confirm/);
  expect(new Set(patches.map(input=>input.operationId)).size).toBe(3);
  const second=await mount(baseUrl,new ForkStore(baseUrl));
  for(const record of second.sides.all()) await expect(second.relations.setLinked(record,false)).rejects.toThrow(/confirm/);
  expect(patches.slice(3).map(input=>input.operationId)).toEqual(patches.slice(0,3).map(input=>input.operationId));
});

it('serializes recovery and preserves a new lost edit across delayed recovery and remount', async()=>{
  const origin={controllerId:'controller',providerId:'codex',nativeSessionId:'main'};
  let shared:SessionRelation[]=[{...side,nativeSourceRef:origin,hostLocator:{hostId:'host',controllerId:'controller'},sourceBinding:{kind:'primary_role',roleId:'role',origin},roleRevision:2}];
  let held:ServerResponse|undefined,oldId=''; let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});const patches:Record<string,unknown>[]=[];
  const baseUrl=await serve(async(request,response)=>{
    if(request.url!.endsWith('/reconcile')){held=response;entered();return;}
    if(request.method==='PATCH'){const input=await body(request);patches.push(input);oldId ||= input.operationId as string;response.destroy();return;}
    reply(response,shared);
  });
  const first=await mount(baseUrl);
  await expect(first.relations.setLinked(first.sides.get('side'),false)).rejects.toThrow(/confirm/);
  const recovering=first.relations.reconcile(first.sides.get('side'));void recovering.catch(()=>{});await started;
  await expect(Promise.race([first.relations.reconcile(first.sides.get('side')),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Concurrent recovery was not rejected')),100))])).rejects.toThrow(/already/);
  shared=[{...shared[0]!,linked:false,revision:1,operation:{operationId:oldId,phase:'committed'}}];
  held!.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({relations:shared,operation:{reservation:{operationId:oldId},phase:'committed'}}));
  await act(async()=>recovering);
  await expect(first.relations.setLinked(first.sides.get('side'),true)).rejects.toThrow(/confirm/);
  const newId=patches[1]!.operationId;expect(newId).not.toBe(oldId);
  const second=await mount(baseUrl,new ForkStore(baseUrl));
  await expect(second.relations.setLinked(second.sides.get('side'),true)).rejects.toThrow(/confirm/);
  expect(patches[2]!.operationId).toBe(newId);
});


it('keeps lost pending unlink reachable in Side entries after refresh and remount, recovers and accepts a new intent',async()=>{
  const origin={controllerId:'controller',providerId:'codex',nativeSessionId:'main'};
  const current={...source,providerId:'claude',nativeSessionId:'B',agentId:'B-agent'};
  let shared:SessionRelation[]=[{...side,source:current,nativeSourceRef:origin,hostLocator:{hostId:'host',controllerId:'controller'},sourceBinding:{kind:'primary_role',roleId:'role',origin},roleRevision:2}];
  let operationId='';const ids:string[]=[];
  const baseUrl=await serve(async(request,response)=>{
    if(request.url!.endsWith('/reconcile')){
      shared=[{...shared[0]!,navigationSource:undefined,operation:{operationId,phase:'committed'}}];
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({relations:shared,operation:{reservation:{operationId},phase:'committed'}}));return;
    }
    if(request.method==='PATCH'){
      const input=await body(request);ids.push(input.operationId as string);operationId=input.operationId as string;
      shared=[{...shared[0]!,source:ids.length===1?source:current,navigationSource:ids.length===1?current:undefined,linked:input.linked as boolean,revision:(shared[0]!.revision??0)+1,operation:{operationId,phase:ids.length===1?'metadata_committed':'committed'}}];
      if(ids.length===1){response.destroy();return;}
    }
    reply(response,shared);
  });
  let recovered:Promise<void>|undefined;let relations!:ReturnType<typeof useSessionRelations>;let sides=new ForkStore(baseUrl);const uiAsks=new ForkStore(baseUrl+'ui-ask');
  function Harness(){const [,update]=useState(0);relations=useSessionRelations(baseUrl,true,sides,uiAsks);
    useEffect(()=>sides.subscribe(()=>update(value=>value+1)),[sides]);
    return <ForkEntries forks={sides.linked().filter(record=>sideNavigationSource(record).agentId==='B-agent')} onOpen={()=>{}} onUnlink={record=>relations.setLinked(record,false)} onRecover={record=>recovered=relations.reconcile(record)}/>;
  }
  const first=await render(<Harness/>);await act(async()=>relations());
  await act(async()=>first.querySelector<HTMLButtonElement>('.lab-fork-menu-trigger')!.click());
  await act(async()=>document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  await act(async()=>relations());expect(sides.linked()).toHaveLength(1);
  await unmount(first);sides=new ForkStore(baseUrl);
  const second=await render(<Harness/>);await act(async()=>relations());
  expect(second.textContent).toContain('Side');expect(sides.all()[0]!.source).toEqual(source);expect(sideNavigationSource(sides.all()[0]!)).toEqual(current);
  await act(async()=>second.querySelector<HTMLButtonElement>('.lab-fork-menu-trigger')!.click());
  const recovery=document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;expect(recovery.textContent).toBe('Retry link change');
  await act(async()=>{recovery.click();await recovered;});expect(sides.linked()).toEqual([]);
  await act(async()=>relations.setLinked(sides.all()[0]!,true));expect(ids[1]).not.toBe(ids[0]);expect(sides.linked()).toHaveLength(1);
});


it('retains stale role intent after bare absence or failed reset and retires it only after exact durable reset',async()=>{
  const origin={controllerId:'controller',providerId:'codex',nativeSessionId:'main'};
  let shared:SessionRelation[]=[{...side,nativeSourceRef:origin,hostLocator:{hostId:'host',controllerId:'controller'},sourceBinding:{kind:'primary_role',roleId:'role',origin},roleRevision:2}];
  const patches:Record<string,unknown>[]=[],resets:Record<string,unknown>[]=[];let resetFails=true;
  const baseUrl=await serve(async(request,response)=>{
    if(request.url!.endsWith('/reconcile')){response.writeHead(404).end();return;}
    if(request.url!.endsWith('/reset')){
      const input=await body(request);resets.push(input);
      if(resetFails){response.writeHead(503).end();return;}
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({relations:shared,reset:{version:1,phase:'pre_effect',intent:{version:1,operationId:input.operationId,
        hostId:'host',controllerId:'controller',readerRef:{...origin,nativeSessionId:'side'},sourceRef:origin,relationId:'side',linked:input.linked,
        expectedRelationRevision:input.expectedRevision,expectedRoleRevision:input.expectedRoleRevision}}}));return;
    }
    if(request.method==='PATCH'){
      patches.push(await body(request));shared=[{...shared[0]!,roleRevision:3}];response.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({relations:shared,code:'invalid_host_response'}));return;
    }
    reply(response,shared);
  });
  const first=await mount(baseUrl);
  await expect(first.relations.setLinked(first.sides.get('side'),false)).rejects.toThrow(/changed/);
  await expect(first.relations.reconcile(first.sides.get('side'))).rejects.toThrow(/pending/);
  await expect(first.relations.setLinked(first.sides.get('side'),false)).rejects.toThrow(/changed/);
  expect(patches[1]).toMatchObject({operationId:patches[0]!.operationId,expectedRoleRevision:2});
  resetFails=false;await act(async()=>first.relations.reconcile(first.sides.get('side')));
  await expect(first.relations.setLinked(first.sides.get('side'),false)).rejects.toThrow(/changed/);
  expect(patches[2]!.operationId).not.toBe(patches[0]!.operationId);expect(patches[2]!.expectedRoleRevision).toBe(3);
  expect(resets[0]).toMatchObject({operationId:patches[0]!.operationId,expectedRoleRevision:2});
});
