import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { IMAGE_INPUT_CAPABILITIES, type AgentInputPart, type AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { InputImageStore } from '../resources/input-image-store.js';
import { createAgentRemoteRelay } from '../relay.js';
import { createAgentRemoteHttpServer } from './http-server.js';

function provider(sent: AgentInputPart[][]): AgentProviderAdapter {
  return { descriptor: { providerId: 'vision', displayName: 'Vision' },
    async createSession(config) {
      let close!: () => void;
      const closed = new Promise<void>(resolve => { close = resolve; });
      return { capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
        imageInput: IMAGE_INPUT_CAPABILITIES, interactions: { question: false, planApproval: false, toolApproval: false } },
      async *observe() { yield { type: 'history_boundary' as const }; await closed; },
      async sendMessage() {}, async sendMessageContent(parts) { sent.push(structuredClone([...parts])); },
      async respondToInteraction() {}, async runtimeInfo() { return { providerId: 'vision', sessionId: config.sessionId, status: 'idle' as const }; },
      async dispose() { close(); } };
    }, async resumeSession() { throw new Error('unused'); },
  };
}

describe('image input over real session WebSocket', () => {
  it.each(['PNG', 'JPEG with auxiliary image'] as const)('resumes %s uploads across reconnect, preserves order and ownership, and denies read-only/activity uploads', async format => {
    const directory = await mkdtemp(join(tmpdir(), 'image-wire-'));
    const sent: AgentInputPart[][] = [];
    const relay = createAgentRemoteRelay({ providers: [provider(sent)], inputImageStore: new InputImageStore({ directory }) });
    const server = createAgentRemoteHttpServer(relay, { websocketAuthorizer: {
      authenticate: request => ({ subject: new URL(request.url!, 'http://local').searchParams.get('subject') ?? 'owner' }),
      authorize: ({ principal, action }) => principal.subject !== 'reader' || ['attach', 'read_resource', 'resolve_resource'].includes(action),
    } });
    const sockets: WebSocket[] = [];
    try {
      const { url } = await server.listen(0, '127.0.0.1');
      for (const agentId of ['a', 'b']) await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: { requestId: randomUUID(), operationId: randomUUID(), agentId, providerId: 'vision', config: { sessionId: agentId } } });
      async function connect(agentId = 'a', subject = 'owner', activity = false) {
        const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events?subject=${subject}`); sockets.push(socket);
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
          const requestId = randomUUID(); socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, ...(['resource_resolve_request', 'resource_request'].includes(type) || !controlToken ? {} : { controlToken }), payload: { agentId, requestId, ...payload } }));
          return next(message => message.type === 'protocol_error' || ('payload' in message && 'requestId' in message.payload && message.payload.requestId === requestId));
        } };
      }
      const primary = await readFile(new URL(`../resources/fixtures/${format === 'PNG' ? 'dimensions.png' : 'rotated.jpg'}`, import.meta.url));
      const bytes = format === 'PNG' ? primary : Buffer.concat([primary, primary]);
      const declaration = { uploadId: 'upload', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, mediaType: format === 'PNG' ? 'image/png' : 'image/jpeg' };
      let connection = await connect();
      expect((await connection.request('image_upload_begin', declaration)).type).toBe('image_upload_result');
      const chunk = { uploadId: 'upload', offset: 0, contentBase64: bytes.subarray(0, 20).toString('base64') };
      expect(await connection.request('image_upload_chunk', chunk)).toMatchObject({ payload: { offset: 20 } });
      connection.socket.terminate(); connection = await connect();
      expect(await connection.request('image_upload_begin', declaration)).toMatchObject({ payload: { offset: 20 } });
      expect(await connection.request('image_upload_chunk', chunk)).toMatchObject({ payload: { offset: 20 } });
      await connection.request('image_upload_chunk', { uploadId: 'upload', offset: 20, contentBase64: bytes.subarray(20).toString('base64') });
      const complete = await connection.request('image_upload_finish', { uploadId: 'upload' });
      if (complete.type !== 'image_upload_result' || !complete.payload.attachment) throw new Error('Missing completed receipt.');
      const attachmentId = complete.payload.attachment.attachmentId;
      const content = [{ type: 'text', text: 'before' }, { type: 'image', attachmentId, label: 'image #1' }, { type: 'text', text: 'after' }];
      expect((await connection.request('send_message', { operationId: randomUUID(), content })).type).toBe('command_acknowledged');
      expect(sent[0]!.map(part => part.type)).toEqual(['text', 'image', 'text']);
      const image = sent[0]![1]!; if (image.type !== 'image') throw new Error('Missing provider image');
      expect(await readFile(image.path)).toEqual(bytes);
      const preview = await connection.request('resource_resolve_request', { locator: `input-image:${attachmentId}` });
      expect(preview).toMatchObject({ payload: { binding: { status: 'available' } } });
      const foreign = await connect('b');
      expect(await foreign.request('send_message', { operationId: randomUUID(), content })).toMatchObject({ type: 'protocol_error', payload: { code: 'invalid_image_input' } });
      expect((await foreign.request('image_upload_finish', { uploadId: 'upload' })).type).toBe('protocol_error');
      const differentOwner = await connect('a', 'other');
      expect(await differentOwner.request('resource_resolve_request', { locator: `input-image:${attachmentId}` })).toMatchObject({ payload: { binding: { status: 'unavailable' } } });
      const reader = await connect('a', 'reader');
      expect(await reader.request('image_upload_begin', declaration)).toMatchObject({ type: 'protocol_error', payload: { code: 'session_read_only' } });
      expect(await reader.request('send_message', { operationId: randomUUID(), content })).toMatchObject({ type: 'protocol_error', payload: { code: 'session_read_only' } });
      const activity = await connect('a', 'owner', true);
      expect(await activity.request('image_upload_begin', declaration)).toMatchObject({ type: 'protocol_error', payload: { code: 'activity_only' } });
      expect(sent).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.terminate();
      await server.close(); await relay.close(); await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
