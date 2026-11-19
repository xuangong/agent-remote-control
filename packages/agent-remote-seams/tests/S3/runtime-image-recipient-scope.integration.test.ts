// @vitest-environment node
import { expect, it } from 'vitest';
import type { ImageUploadReceipt } from '@orchardworks/agent-remote-protocol';
import { uploadImage } from '@orchardworks/agent-client';

it('keeps A, B and C image receipts scoped to their concrete recipients over a real WebSocket', async () => {
  const { randomUUID } = await import('node:crypto');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: events } = await import('node:events'); const once = events.once;
  const { PROTOCOL_VERSION } = await import('@orchardworks/agent-remote-protocol');
  const { IMAGE_INPUT_CAPABILITIES } = await import('@orchardworks/agent-provider-sdk');
  const { InputImageStore } = await import('@orchardworks/agent-session-runtime');
  const { createAgentRemoteRelay } = await import('@orchardworks/agent-session-runtime');
  const { createAgentRemoteHttpServer } = await import('@orchardworks/agent-session-runtime');
  const { memoryHttp } = await import('@orchardworks/agent-session-runtime/testing');
  type ServerMessage = import('@orchardworks/agent-remote-protocol').ServerMessage;
  type InputPart = import('@orchardworks/agent-provider-sdk').AgentInputPart;
  const directory = await mkdtemp(join(tmpdir(), 'recipient-contract-'));
  const sent: Array<{ native: string; parts: readonly InputPart[] }> = [];
  const provider: import('@orchardworks/agent-provider-sdk').AgentProviderAdapter = {
    descriptor: { providerId: 'vision', displayName: 'Vision fixture' },
    async createSession(config) {
      let finish!: () => void; const ended = new Promise<void>(resolve => { finish = resolve; });
      return { capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, imageInput: IMAGE_INPUT_CAPABILITIES,
        interactions: { question: false, planApproval: false, toolApproval: false } },
        async *observe() { yield { type: 'history_boundary' as const }; await ended; },
        async sendMessage() {}, async sendMessageContent(parts) { sent.push({ native: String(config.sessionId), parts }); },
        async respondToInteraction() {}, async runtimeInfo() { return { providerId: 'vision', sessionId: config.sessionId, status: 'idle' as const }; },
        async dispose() { finish(); } };
    }, async resumeSession() { throw new Error('Unused'); },
  };
  const relay = createAgentRemoteRelay({ providers: [provider], inputImageStore: new InputImageStore({ directory }) });
  const server = createAgentRemoteHttpServer(relay, { websocketAuthorizer: { authenticate: () => ({ subject: 'fixture-owner' }), authorize: () => true } });
  const sockets: import('ws').WebSocket[] = [];
  try {
    const net = memoryHttp(server.server), url = net.url;
    async function connect(agentId: string) {
      await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: { requestId: randomUUID(), operationId: randomUUID(), agentId, providerId: 'vision', config: { sessionId: agentId } } });
      const socket = net.webSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events`); sockets.push(socket);
      const messages: ServerMessage[] = []; const listeners = new Set<() => void>();
      socket.on('message', data => { messages.push(JSON.parse(String(data))); for (const listener of listeners) listener(); });
      await once(socket, 'open');
      let phase = 'negotiate';
      const next = (predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Wire deadline during ${phase}.`)); }, 2000);
        function check() { const index = messages.findIndex(predicate); if (index >= 0) { clearTimeout(timer); listeners.delete(check); resolve(messages.splice(index, 1)[0]!); } }
        listeners.add(check); check();
      });
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
      await next(message => message.type === 'negotiated');
      const state = await next(message => message.type === 'session_control');
      if (state.type !== 'session_control') throw new Error('Missing control');
      phase = 'control';
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { agentId, requestId: 'control', action: 'take_over', revision: state.payload.revision } }));
      const control = await next(message => message.type === 'session_control' && message.payload.requestId === 'control');
      if (control.type !== 'session_control') throw new Error('Missing control receipt');
      return async (type: string, payload: Record<string, unknown>) => {
        const requestId = randomUUID(); phase = type;
        socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, controlToken: control.payload.token, payload: { ...payload, agentId, requestId } }));
        return next(message => 'payload' in message && 'requestId' in message.payload && message.payload.requestId === requestId);
      };
    }
    const bytes = await readFile(new URL('./fixtures/dimensions.png', import.meta.url));
    const file = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    let previous: NonNullable<ImageUploadReceipt['attachment']> | undefined;
    for (const native of ['A', 'B', 'C']) {
      const request = await connect(native);
      if (previous) expect(await request('send_message', { operationId: randomUUID(), content: [{ type: 'image', attachmentId: previous.attachmentId, label: 'image #1' }] })).toMatchObject({ type: 'protocol_error', payload: { code: 'invalid_image_input' } });
      const own = await uploadImage(file, 'same-upload-id', async message => {
        const { type, ...payload } = message; const response = await request(type, { uploadId: 'same-upload-id', ...payload });
        if (response.type !== 'image_upload_result') throw new Error(`Upload failed: ${response.type}`);
        return response.payload;
      });
      expect(await request('send_message', { operationId: randomUUID(), content: [{ type: 'image', attachmentId: own.attachmentId, label: 'image #1' }] })).toMatchObject({ type: 'command_acknowledged' });
      previous = own;
    }
    expect(sent.map(value => value.native)).toEqual(['A', 'B', 'C']);
    for (const input of sent) { const image = input.parts[0]!; if (image.type !== 'image') throw new Error('Missing image'); expect((await readFile(image.path)).equals(bytes)).toBe(true); }
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close(); await relay.close(); await rm(directory, { recursive: true, force: true });
  }
});
