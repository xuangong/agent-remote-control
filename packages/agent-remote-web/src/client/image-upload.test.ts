// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ImageUploadReceipt } from '@orchardworks/agent-remote-protocol';
import { uploadImage } from './image-upload.js';

const attachment = { attachmentId: 'image-one', sha256: '', mediaType: 'image/png' as const, byteLength: 70000, imageDimensions: { width: 1, height: 1 } };
describe('image upload', () => {
  it('resumes from the acknowledged offset', async () => {
    const file = new Blob([new Uint8Array(70000)], { type: 'image/png' });
    const offsets: number[] = [];
    let digest = '';
    const result = await uploadImage(file, 'upload-one', async request => {
      await Promise.resolve();
      if (request.type === 'image_upload_begin') { digest = request.sha256; return { uploadId: 'upload-one', offset: 123 }; }
      if (request.type === 'image_upload_chunk') {
        offsets.push(request.offset);
        const length = atob(request.contentBase64).length;
        expect(length).toBeLessThanOrEqual(32768);
        return { uploadId: 'upload-one', offset: request.offset + length };
      }
      return { uploadId: 'upload-one', offset: 70000, attachment: { ...attachment, sha256: digest } };
    });
    expect(offsets).toEqual([123, 32891, 65659]);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  function controlledUpload(signal?: AbortSignal) {
    const size = 10 * 32768 + 17;
    const chunks: { offset: number; accept(): void; reject(error: Error): void }[] = [];
    const progress: number[] = [];
    let finishes = 0;
    let digest = '';
    const result = uploadImage(new Blob([new Uint8Array(size)], { type: 'image/png' }), 'u', async request => {
      if (request.type === 'image_upload_begin') { digest = request.sha256; return { uploadId: 'u', offset: 123 }; }
      if (request.type === 'image_upload_finish') {
        finishes++;
        return { uploadId: 'u', offset: size, attachment: { ...attachment, sha256: digest, byteLength: size } };
      }
      return new Promise<ImageUploadReceipt>((resolve, reject) => {
        chunks.push({ offset: request.offset, reject,
          accept: () => resolve({ uploadId: 'u', offset: request.offset + atob(request.contentBase64).length }) });
      });
    }, { signal, onProgress: loaded => progress.push(loaded) });
    // Observe rejection immediately, including failures in non-head requests.
    let settled = false;
    const outcome = result.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    return { chunks, progress, result, outcome, finishes: () => finishes, settled: () => settled };
  }

  it('fills eight ordered slots, refills after acknowledgement, and finishes only after all receipts', async () => {
    const upload = controlledUpload();
    await vi.waitFor(() => expect(upload.chunks).toHaveLength(8), { timeout: 1000, interval: 5 });
    expect(upload.chunks.map(chunk => chunk.offset)).toEqual(Array.from({ length: 8 }, (_, i) => 123 + i * 32768));
    expect(upload.progress).toEqual([123]);
    expect(upload.finishes()).toBe(0);
    upload.chunks[1]!.accept();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(upload.progress).toEqual([123]);
    expect(upload.chunks).toHaveLength(8);
    upload.chunks[0]!.accept();
    await vi.waitFor(() => expect(upload.chunks).toHaveLength(10), { timeout: 1000, interval: 5 });
    expect(upload.progress).toEqual([123, 32891, 65659]);
    for (const chunk of upload.chunks.slice(2, 9)) chunk.accept();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(upload.finishes()).toBe(0);
    upload.chunks[9]!.accept();
    await expect(upload.result).resolves.toMatchObject({ byteLength: 10 * 32768 + 17 });
    expect(upload.finishes()).toBe(1);
    expect(upload.progress.at(-1)).toBe(10 * 32768 + 17);
  });

  it.each(['failure', 'abort'] as const)('stops scheduling and drains in-flight chunks on %s', async mode => {
    const abort = new AbortController();
    const upload = controlledUpload(abort.signal);
    await vi.waitFor(() => expect(upload.chunks).toHaveLength(8), { timeout: 1000, interval: 5 });
    if (mode === 'abort') abort.abort();
    else upload.chunks[7]!.reject(new Error('Host disconnected'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(upload.settled()).toBe(false);
    for (const chunk of upload.chunks) chunk.accept();
    const outcome = await upload.outcome;
    expect(outcome).toHaveProperty('error');
    if ('error' in outcome) expect(outcome.error).toMatchObject(mode === 'abort' ? { name: 'AbortError' } : { message: 'Host disconnected' });
    expect(upload.chunks).toHaveLength(8);
    expect(upload.finishes()).toBe(0);
  });

  it('rejects an abort while awaiting a receipt without sending more chunks', async () => {
    const abort = new AbortController();
    let requests = 0;
    const pending = uploadImage(new Blob(['abc'], { type: 'image/png' }), 'u', async () => {
      requests++;
      abort.abort();
      return { uploadId: 'u', offset: 0 };
    }, { signal: abort.signal });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(1);
  });

  it('rejects a receipt that does not advance the accepted offset', async () => {
    await expect(uploadImage(new Blob(['abc'], { type: 'image/png' }), 'u', async () => ({ uploadId: 'u', offset: 0 }))).rejects.toThrow(/offset/i);
  });
});

it('keeps A, B and C image receipts scoped to their concrete recipients over a real WebSocket', async () => {
  const { randomUUID } = await import('node:crypto');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { once } = await import('node:events');
  const { default: WebSocket } = await import('ws');
  const { PROTOCOL_VERSION } = await import('@orchardworks/agent-remote-protocol');
  const { IMAGE_INPUT_CAPABILITIES } = await import('../../../agent-provider-sdk/src/index.js');
  const { InputImageStore } = await import('../../../agent-remote-relay/src/resources/input-image-store.js');
  const { createAgentRemoteRelay } = await import('../../../agent-remote-relay/src/relay.js');
  const { createAgentRemoteHttpServer } = await import('../../../agent-remote-relay/src/transport/http-server.js');
  type ServerMessage = import('@orchardworks/agent-remote-protocol').ServerMessage;
  type InputPart = import('../../../agent-provider-sdk/src/index.js').AgentInputPart;
  const directory = await mkdtemp(join(tmpdir(), 'recipient-contract-'));
  const sent: Array<{ native: string; parts: readonly InputPart[] }> = [];
  const provider: import('../../../agent-provider-sdk/src/index.js').AgentProviderAdapter = {
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
    const { url } = await server.listen(0, '127.0.0.1');
    async function connect(agentId: string) {
      await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: { requestId: randomUUID(), operationId: randomUUID(), agentId, providerId: 'vision', config: { sessionId: agentId } } });
      const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events`); sockets.push(socket);
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
    const bytes = await readFile(new URL('../../../agent-remote-relay/src/resources/fixtures/dimensions.png', import.meta.url));
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
    for (const input of sent) { const image = input.parts[0]!; if (image.type !== 'image') throw new Error('Missing image'); expect(await readFile(image.path)).toEqual(bytes); }
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close(); await relay.close(); await rm(directory, { recursive: true, force: true });
  }
});
