import { InputImageStore } from '../resources/input-image-store.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { IMAGE_INPUT_CAPABILITIES, RESOURCE_INPUT_CAPABILITIES, type AgentInputPart, type AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { InputResourceStore } from '../resources/input-resource-store.js';
import { createAgentRemoteRelay } from '../relay.js';
import { createAgentRemoteHttpServer } from './http-server.js';


function provider(sent: AgentInputPart[][]): AgentProviderAdapter {
  return { descriptor: { providerId: 'vision', displayName: 'Vision' },
    async createSession(config) {
      let close!: () => void;
      const closed = new Promise<void>(resolve => { close = resolve; });
      return { capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
        imageInput: IMAGE_INPUT_CAPABILITIES, resourceInput: RESOURCE_INPUT_CAPABILITIES, interactions: { question: false, planApproval: false, toolApproval: false } },
      async *observe() { yield { type: 'history_boundary' as const }; await closed; },
      async sendMessage() {}, async sendMessageContent(parts) { sent.push(structuredClone([...parts])); },
      async respondToInteraction() {}, async runtimeInfo() { return { providerId: 'vision', sessionId: config.sessionId, status: 'idle' as const }; },
      async dispose() { close(); } };
    }, async resumeSession() { throw new Error('unused'); },
  };
}

describe('resource input over real session WebSocket', () => {
  it('resumes binary resources across reconnect, preserves order and denies foreign/read-only/activity access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'image-wire-'));
    const sent: AgentInputPart[][] = [];
    const relay = createAgentRemoteRelay({ providers: [provider(sent)], inputResourceStore: new InputResourceStore({ directory }), inputImageStore:new InputImageStore({directory:join(directory,'images')}) });
    const server = createAgentRemoteHttpServer(relay, { websocketAuthorizer: {
      authenticate: request => { const params=new URL(request.url!,'http://local').searchParams; return {subject:params.get('subject')??'owner',readOnly:params.get('readonly')==='1'}; },
      authorize: ({ principal, action }) => (principal.subject !== 'reader' && !principal.readOnly) || ['attach', 'read_resource', 'resolve_resource'].includes(action),
    } });
    const sockets: WebSocket[] = [];
    try {
      const { url } = await server.listen(0, '127.0.0.1');
      for (const agentId of ['a', 'b']) await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: { requestId: randomUUID(), operationId: randomUUID(), agentId, providerId: 'vision', config: { sessionId: agentId } } });
      async function connect(agentId = 'a', subject = 'owner', activity = false, readOnly = false) {
        const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events?subject=${subject}&readonly=${readOnly?1:0}`); sockets.push(socket);
        const messages: ServerMessage[] = []; const listeners = new Set<() => void>();
        socket.on('message', data => { messages.push(JSON.parse(data.toString())); for (const listener of listeners) listener(); });
        await once(socket, 'open');
        const next = (matches: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Wire response deadline exceeded.')); }, 2000);
          function check() { const index = messages.findIndex(matches); if (index < 0) return; clearTimeout(timer); listeners.delete(check); resolve(messages.splice(index, 1)[0]!); }
          listeners.add(check); check();
        });
        socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate', ...(activity ? { observation: 'activity' } : {}) }));
        await next(message => message.type === 'negotiated');
        let controlToken: string | undefined;
        if (!activity) {
          const state = await next(message => message.type === 'session_control');
          if (state.type !== 'session_control') throw new Error('Missing control state');
          socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: {
            agentId, requestId: 'take-control', action: 'take_over', revision: state.payload.revision,
          } }));
          const granted = await next(message => message.type === 'protocol_error' || (message.type === 'session_control' && message.payload.requestId === 'take-control'));
          if (granted.type === 'session_control') controlToken = granted.payload.token;
        }
        return { socket, async request(type: string, payload: Record<string, unknown> = {}) {
          const requestId = randomUUID(); socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, ...(['resource_resolve_request', 'resource_request', 'resource_download_request'].includes(type) || !controlToken ? {} : { controlToken }), payload: { agentId, requestId, ...payload } }));
          return next(message => message.type === 'protocol_error' || ('payload' in message && 'requestId' in message.payload && message.payload.requestId === requestId));
        } };
      }
      const bytes = Buffer.alloc(100000, 255);
      const declaration = { uploadId: 'upload', name:'test.zip', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, mediaType: 'application/zip' };
      let connection = await connect();
      expect((await connection.request('resource_upload_begin', declaration)).type).toBe('resource_upload_result');
      const chunk = { uploadId: 'upload', offset: 0, contentBase64: bytes.subarray(0, 20).toString('base64') };
      expect(await connection.request('resource_upload_chunk', chunk)).toMatchObject({ payload: { offset: 20 } });
      connection.socket.terminate(); connection = await connect();
      expect(await connection.request('resource_upload_begin', declaration)).toMatchObject({ payload: { offset: 20 } });
      expect(await connection.request('resource_upload_chunk', chunk)).toMatchObject({ payload: { offset: 20 } });
      for(let offset=20;offset<bytes.length;offset+=32768) expect((await connection.request('resource_upload_chunk',{uploadId:'upload',offset,contentBase64:bytes.subarray(offset,offset+32768).toString('base64')})).type).toBe('resource_upload_result');
      const finished=await connection.request('resource_upload_finish',{uploadId:'upload'});
      if(finished.type!=='resource_upload_result') throw new Error('Missing resource receipt');
      const resourceId=finished.payload.resource!.resourceId;
      const content = [{ type: 'text', text: 'before' }, { type: 'resource', resourceId, label: 'image #1' }, { type: 'text', text: 'after' }];
      expect((await connection.request('send_message', { operationId: randomUUID(), content })).type).toBe('command_acknowledged');
      expect(sent[0]!.map(part => part.type)).toEqual(['text', 'resource', 'text']);
      const image = sent[0]![1]!; if (image.type !== 'resource') throw new Error('Missing provider image');
      expect(await readFile(image.path)).toEqual(bytes);
      const preview = await connection.request('resource_download_request', { resourceId, offset:0 });
      expect(preview).toMatchObject({type:'resource_download_result', payload:{sha256:declaration.sha256,offset:0}});
      const png=await readFile(new URL('../resources/fixtures/dimensions.png',import.meta.url));
      await connection.request('image_upload_begin',{uploadId:'image',mediaType:'image/png',byteLength:png.length,sha256:createHash('sha256').update(png).digest('hex')});
      await connection.request('image_upload_chunk',{uploadId:'image',offset:0,contentBase64:png.toString('base64')});
      const imageReceipt=await connection.request('image_upload_finish',{uploadId:'image'});if(imageReceipt.type!=='image_upload_result')throw new Error('Missing image receipt');
      expect((await connection.request('send_message',{operationId:randomUUID(),content:[{type:'image',attachmentId:imageReceipt.payload.attachment!.attachmentId,label:'image #1'},...content]})).type).toBe('command_acknowledged');
      expect(sent[1]!.map(part=>part.type)).toEqual(['image','text','resource','text']);
      const foreign = await connect('b');
      expect(await foreign.request('send_message', { operationId: randomUUID(), content })).toMatchObject({ type: 'protocol_error', payload: { code: 'invalid_resource_input' } });
      expect((await foreign.request('resource_upload_finish', { uploadId: 'upload' })).type).toBe('protocol_error');
      const differentOwner = await connect('a', 'other');
      expect(await differentOwner.request('resource_download_request', { resourceId,offset:0 })).toMatchObject({type:'protocol_error'});
      const historyReader = await connect('a','owner',false,true);
      expect(await historyReader.request('resource_download_request',{resourceId,offset:32768})).toMatchObject({type:'resource_download_result',payload:{offset:32768}});
      expect(await historyReader.request('resource_upload_begin',declaration)).toMatchObject({type:'protocol_error',payload:{code:'session_read_only'}});
      const reader = await connect('a', 'reader');
      expect(await reader.request('resource_upload_begin', declaration)).toMatchObject({ type: 'protocol_error', payload: { code: 'session_read_only' } });
      expect(await reader.request('send_message', { operationId: randomUUID(), content })).toMatchObject({ type: 'protocol_error', payload: { code: 'session_read_only' } });
      const activity = await connect('a', 'owner', true);
      expect(await activity.request('resource_upload_begin', declaration)).toMatchObject({ type: 'protocol_error', payload: { code: 'activity_only' } });
      expect(sent).toHaveLength(2);
    } finally {
      for (const socket of sockets) socket.terminate();
      await server.close(); await relay.close(); await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
