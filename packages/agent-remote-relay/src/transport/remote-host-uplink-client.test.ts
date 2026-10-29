import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createAgentRemoteRelay } from '../relay.js';
import { createRemoteHostUplinkClient, type RemoteHostUplinkClientOptions } from './remote-host-uplink-client.js';

it.each([true, false])('routes create through the trusted existing callback only with acknowledged v2=%s', async acknowledged => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closeables.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const authority = { version: 1 as const, origin, issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
  const responses: Array<{ status: number; body: string }> = [];
  let connection!: WebSocket;
  server.on('connection', socket => {
    connection = socket;
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 },
        ...(acknowledged ? { successionEnrollment: authority, successionEnrollmentVersion: 2 } : {}) }));
      if (message.type === 'rpc_response') responses.push(message);
    });
  });
  const relay = createAgentRemoteRelay({ providers: [] }); closeables.push(() => relay.close());
  const trusted: unknown[] = [], ordinary: unknown[] = [];
  const client = createRemoteHostUplinkClient({ relay, installationId: 'machine', name: 'Machine', remoteKey: 'key', providers: [], url: origin.replace('http:', 'ws:') + '/ws/remote-host',
    resolveSession: () => undefined, control: async request => { ordinary.push(request); return { status: 200, body: 'ordinary' }; },
    successionEnrollment: { control: async (request, context) => { expect(context.installationId).toBe('machine'); trusted.push({ request, context }); context.installationId = 'mutated'; return { status: 200, body: 'trusted' }; } } });
  closeables.push(() => client.close()); await client.ready;
  for (const requestId of ['first', 'second']) {
    connection.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId, method: 'POST', path: '/remote/create', sessionId: 'proposal', body: '{"context":"forged"}' }));
    await until(() => responses.length === (requestId === 'first' ? 1 : 2));
  }
  expect(responses.map(response => response.body)).toEqual(acknowledged ? ['trusted', 'trusted'] : ['ordinary', 'ordinary']);
  if (acknowledged) {
    expect(ordinary).toEqual([]);
    expect(trusted).toEqual(['first', 'second'].map(requestId => ({ request: { requestId, method: 'POST', path: '/remote/create', sessionId: 'proposal', body: '{"context":"forged"}', operationScope: JSON.stringify([origin.replace('http:', 'ws:'), 'host', 'machine']) },
      context: { authority, installationId: 'mutated', successionEnrollmentVersion: 2 } })));
  } else expect(trusted).toEqual([]);
});

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });

async function broker(heartbeat: { intervalMs: number; timeoutMs: number }, providers?: Array<{ providerId: string; displayName: string }>,
  control: RemoteHostUplinkClientOptions['control'] = async () => ({ status: 404, body: '{}' })) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closeables.push(() => new Promise<void>(resolve => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  }));
  const connections: WebSocket[] = [], pings: Buffer[] = [], states: string[] = [], acknowledgements: string[] = [];
  let registrations = 0; let registeredProviders: unknown;
  const responses: Array<{ requestId: string; status: number; body: string }> = [];
  server.on('connection', socket => {
    connections.push(socket);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') {
        registrations += 1;
        registeredProviders = message.providers;
        socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat }));
      }
      if (message.type === 'heartbeat_ack') acknowledgements.push(message.nonce);
      if (message.type === 'rpc_response') responses.push(message);
    });
    socket.on('ping', payload => { pings.push(Buffer.from(payload)); });
  });
  const relay = createAgentRemoteRelay({ providers: [] });
  closeables.push(() => relay.close());
  const client = createRemoteHostUplinkClient({ relay, installationId: 'machine', name: 'Machine', remoteKey: 'key', providers,
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`,
    resolveSession: () => undefined, control,
    reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10,
    onStateChange: state => states.push(state),
  });
  closeables.push(() => client.close());
  await client.ready;
  return { client, connections, pings, states, acknowledgements, responses, registrations: () => registrations, registeredProviders: () => registeredProviders };
}

it('registers an enrollment-only Host over WebSocket with an empty provider list', async () => {
  const b = await broker({ intervalMs: 30000, timeoutMs: 10000 }, []);
  expect(b.registeredProviders()).toEqual([]);
  expect(b.states).toEqual(['connecting', 'registered']);
}, 10000);

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await delay(5);
  expect(predicate()).toBe(true);
}

describe('Remote Host uplink heartbeat', () => {
  const heartbeat = { intervalMs: 100, timeoutMs: 40 };

  it('acknowledges cloud challenges without sending native pings', async () => {
    const b = await broker(heartbeat);
    for (const nonce of ['first', 'second', 'third', 'fourth']) {
      await delay(60);
      b.connections[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce }));
      await until(() => b.acknowledgements.includes(nonce));
    }
    expect(b.acknowledgements).toEqual(['first', 'second', 'third', 'fourth']);
    expect(b.pings).toHaveLength(0);
    expect(b.registrations()).toBe(1);
  });

  it('reconnects when the cloud connection sends no heartbeat', async () => {
    const b = await broker(heartbeat);
    await until(() => b.registrations() >= 2);
    b.connections[1]!.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: 'reconnected' }));
    await until(() => b.acknowledgements.includes('reconnected'));
    expect(b.connections[0]!.readyState).toBe(3);
    expect(b.pings).toHaveLength(0);
  });

  it('keeps the uplink and heartbeat alive after workspace folder requests', async () => {
    const b = await broker({ intervalMs: 2000, timeoutMs: 500 });
    const socket = b.connections[0]!;
    for (const [index, query] of ['', '?providerId=codex&path=%2FUsers%2Fworkspace', '?hidden=1&search=project&offset=100'].entries()) {
      const requestId = `folders-${index}`;
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId, method: 'GET', path: `/remote/workspace-folders${query}` }));
      await until(() => b.responses.some(response => response.requestId === requestId));
      expect(b.responses.find(response => response.requestId === requestId)).toMatchObject({ status: 404, body: '{}' });
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: requestId }));
      await until(() => b.acknowledgements.includes(requestId));
    }
    expect(socket.readyState).toBe(1);
    expect(b.registrations()).toBe(1);
    expect(b.states).toEqual(['connecting', 'registered']);
  });

  it('does not postpone cloud silence detection for repeated registrations or business traffic', async () => {
    const b = await broker(heartbeat);
    const first = b.connections[0]!;
    const traffic = setInterval(() => {
      if (first.readyState !== 1) return;
      first.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat }));
      first.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId: 'catalog', method: 'GET', path: '/remote/catalog' }));
    }, 20);
    try {
      await delay(70);
      expect(b.registrations()).toBe(1);
      expect(first.readyState).toBe(1);
      await until(() => b.registrations() >= 2);
    }
    finally { clearInterval(traffic); }
    expect(first.readyState).toBe(3);
    expect(b.pings).toHaveLength(0);
  });

  it('cleans the cloud watchdog when actively closed and when policy rejects the connection', async () => {
    for (const rejected of [false, true]) {
      const b = await broker(heartbeat);
      if (rejected) {
        b.connections[0]!.close(1008, 'Device revoked');
        await until(() => b.states.includes('rejected'));
      } else await b.client.close();
      await delay(200);
      expect(b.registrations()).toBe(1);
      expect(b.pings).toHaveLength(0);
      expect(b.states).toEqual(['connecting', 'registered', rejected ? 'rejected' : 'closed']);
    }
  });
});

it('delivers a session rename over the live uplink without disconnecting the Host', async () => {
  const body = JSON.stringify({ providerId: 'codex', nativeSessionId: 'native', title: 'Renamed', operationId: 'rename-intent' });
  const requests: unknown[] = [];
  const b = await broker({ intervalMs: 30000, timeoutMs: 10000 }, undefined, async request => {
    requests.push(request);
    return { status: 200, body: JSON.stringify({ title: 'Renamed' }) };
  });
  const socket = b.connections[0]!;
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId: 'rename',
    method: 'POST', path: '/remote/session/rename', body }));
  await until(() => b.responses.length === 1);
  expect(requests).toEqual([{ requestId: 'rename', method: 'POST', path: '/remote/session/rename', body,
    operationScope: expect.any(String) }]);
  expect(b.responses).toEqual([{ uplinkVersion: 2, type: 'rpc_response', requestId: 'rename', status: 200,
    body: JSON.stringify({ title: 'Renamed' }) }]);
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat', nonce: 'after-rename' }));
  await until(() => b.acknowledgements.includes('after-rename'));
  expect(socket.readyState).toBe(1);
  expect(b.registrations()).toBe(1);
  expect(b.states).toEqual(['connecting', 'registered']);
}, 10000);

it('keeps an older Relay connection while refusing unnegotiated succession control', async () => {
  const b = await broker({ intervalMs: 30000, timeoutMs: 10000 }, [], async () => ({ status: 200, body: 'bypass' }));
  b.connections[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_request', requestId: 'untrusted', method: 'POST', path: '/remote/succession/enrollment', body: '{}' }));
  await until(() => b.responses.some(response => response.requestId === 'untrusted'));
  expect(b.responses.find(response => response.requestId === 'untrusted')!.status).toBe(403);
  expect(b.states).toEqual(['connecting', 'registered']);
  expect(b.connections[0]!.readyState).toBe(1);
}, 10000);

it.each([true, false])('negotiates Team transport without breaking older Relay registrations (supported=%s)', async supported => {
  const server = new WebSocketServer({host:'127.0.0.1',port:0}); await new Promise<void>(resolve=>server.once('listening',resolve));
  closeables.push(()=>new Promise<void>(resolve=>{for(const socket of server.clients)socket.terminate();server.close(()=>resolve());}));
  let registration:unknown, requests=0, endpoint='';
  server.on('connection',(socket,request)=>{endpoint=request.url!;socket.on('message',data=>{
    const message=JSON.parse(data.toString());
    if(message.type==='register'){registration=message;socket.send(JSON.stringify({uplinkVersion:2,type:'registered',hostId:'host',heartbeat:{intervalMs:30000,timeoutMs:10000},...(supported?{teamManagement:true}:{})}));}
    if(message.type==='team_request'){requests++;socket.send(JSON.stringify({uplinkVersion:2,type:'team_response',requestId:message.requestId,status:200,body:'[]'}));}
  });});
  const relay=createAgentRemoteRelay({providers:[]});closeables.push(()=>relay.close());
  const client=createRemoteHostUplinkClient({relay,installationId:'host',name:'Host',remoteKey:'key',providers:[],teamManagement:true,url:`ws://127.0.0.1:${(server.address() as {port:number}).port}/ws/remote-host`,resolveSession:()=>undefined,control:()=>({status:404,body:'{}'})});
  closeables.push(()=>client.close());await client.ready;expect(endpoint).toContain('team=1');expect(registration).not.toHaveProperty('teamManagement');
  if(supported){expect(await client.teamRequest({action:'poll'})).toEqual([]);expect(requests).toBe(1);}
  else {await expect(client.teamRequest({action:'poll'})).rejects.toThrow('unavailable');expect(requests).toBe(0);}
});

it('keeps an older Team Relay connected and rejects unnegotiated resource calls locally', async () => {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
  closeables.push(()=>new Promise<void>(resolve=>{for(const socket of server.clients)socket.terminate();server.close(()=>resolve());}));
  let requests=0;
  server.on('connection',socket=>socket.on('message',data=>{const message=JSON.parse(data.toString());
    if(message.type==='register')socket.send(JSON.stringify({uplinkVersion:2,type:'registered',hostId:'host',teamManagement:true,heartbeat:{intervalMs:30000,timeoutMs:10000}}));
    if(message.type==='team_request'){requests++;socket.send(JSON.stringify({uplinkVersion:2,type:'team_response',requestId:message.requestId,status:200,body:'[]'}));}
  }));
  const relay=createAgentRemoteRelay({providers:[]});closeables.push(()=>relay.close());
  const client=createRemoteHostUplinkClient({relay,installationId:'host',name:'Host',remoteKey:'key',providers:[],teamManagement:true,url:`ws://127.0.0.1:${(server.address() as {port:number}).port}/ws/remote-host`,resolveSession:()=>undefined,control:()=>({status:404,body:'{}'})});closeables.push(()=>client.close());
  await client.ready;
  await expect(client.teamRequest({action:'resource_metadata',teamId:'team',memberId:'member',resourceId:'resource'})).rejects.toThrow('resources are unavailable');
  expect(requests).toBe(0);expect(await client.teamRequest({action:'poll'})).toEqual([]);expect(requests).toBe(1);
});

it.each([true, false])('reports session states only to a Relay that acknowledged them (acknowledged=%s)', async acknowledged => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closeables.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  const reports: unknown[] = []; let requested: string | null = null;
  server.on('connection', (socket, request) => {
    requested = new URL(request.url!, 'http://relay').searchParams.get('sessionStates');
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 }, ...(acknowledged ? { sessionStates: 1 } : {}) }));
      if (message.type === 'session_states') reports.push(message);
    });
  });
  const listeners = new Set<(report: { full: boolean; states: never[] }) => void>();
  const relay = createAgentRemoteRelay({ providers: [] }); closeables.push(() => relay.close());
  const running = { providerId: 'codex', nativeSessionId: 'thread', state: 'running' as const };
  const client = createRemoteHostUplinkClient({ relay, installationId: 'machine', name: 'Machine', remoteKey: 'key', providers: [],
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, resolveSession: () => undefined, control: async () => ({ status: 404, body: '{}' }),
    sessionStates: { snapshot: () => [running] as never[], subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } } });
  closeables.push(() => client.close()); await client.ready;
  expect(requested).toBe('1');
  if (!acknowledged) { await delay(50); expect(reports).toEqual([]); expect(listeners.size).toBe(0); return; }
  await until(() => reports.length === 1);
  expect(reports[0]).toEqual({ uplinkVersion: 2, type: 'session_states', full: true, states: [running] });
  for (const listener of listeners) listener({ full: false, states: [], removed: [{ providerId: 'codex', nativeSessionId: 'thread' }] } as never);
  await until(() => reports.length === 2);
  expect(reports[1]).toEqual({ uplinkVersion: 2, type: 'session_states', full: false, states: [], removed: [{ providerId: 'codex', nativeSessionId: 'thread' }] });
  await client.close();
  expect(listeners.size).toBe(0);
});

it.each([[true, true], [true, false], [false, true]])('requests Call For Support only when asked and tracks the acknowledgement (requested=%s, acknowledged=%s)', async (requested, acknowledged) => {
  const server = new WebSocketServer({host:'127.0.0.1',port:0}); await new Promise<void>(resolve=>server.once('listening',resolve));
  closeables.push(()=>new Promise<void>(resolve=>{for(const socket of server.clients)socket.terminate();server.close(()=>resolve());}));
  let endpoint='';
  server.on('connection',(socket,request)=>{endpoint=request.url!;socket.on('message',data=>{
    const message=JSON.parse(data.toString());
    const offered=new URL(endpoint,'http://localhost').searchParams.get('callForSupport')==='1';
    if(message.type==='register')socket.send(JSON.stringify({uplinkVersion:2,type:'registered',hostId:'host',heartbeat:{intervalMs:30000,timeoutMs:10000},teamManagement:true,teamRecipients:1,teamSuccession:1,...(acknowledged&&offered?{callForSupport:1}:{})}));
  });});
  const relay=createAgentRemoteRelay({providers:[]});closeables.push(()=>relay.close());
  const client=createRemoteHostUplinkClient({relay,installationId:'host',name:'Host',remoteKey:'key',providers:[{providerId:'codex',displayName:'Codex',readOnly:true}],teamManagement:true,...(requested?{callForSupport:true as const}:{}),url:`ws://127.0.0.1:${(server.address() as {port:number}).port}/ws/remote-host`,resolveSession:()=>undefined,control:()=>({status:404,body:'{}'})});
  closeables.push(()=>client.close());await client.ready;
  expect(new URL(endpoint,'http://localhost').searchParams.get('callForSupport')).toBe(requested?'1':null);
  expect(client.callForSupport).toBe(requested&&acknowledged);
});
