import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  ProviderStreamItem,
} from '@borgee/agent-provider-sdk';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createLiveDshProvider } from './live-provider.js';
import type { DshNativeObservation } from './native.js';
import type { DshOwnedAgent, DshRuntime } from './runtime.js';

function sessionEvent(seq: number, type: string, data: Record<string, unknown>, recordId = `event-${seq}`): DshNativeObservation {
  return {
    recordId,
    occurredAt: 1_725_000_000_000 + seq,
    kind: 'session_event',
    payload: { type, seq, data },
  };
}

function interaction(recordId: string, request: AgentInteractionRequest): DshNativeObservation {
  return {
    recordId,
    occurredAt: 1_725_000_000_100,
    kind: 'interaction_requested',
    payload: { request, turnId: 'turn-1' },
  };
}

function writeRecords(
  callId: string,
  filePath: string,
  content: string,
  failed = false,
  seqStart = 0,
): DshNativeObservation[] {
  return [
    sessionEvent(seqStart, 'tool/call', {
      turn: 'turn-1', callId, name: 'write',
      arguments: JSON.stringify({ file_path: filePath, content }),
    }),
    sessionEvent(seqStart + 1, 'tool/result', {
      turn: 'turn-1', callId,
      message: { content: [{ type: 'text', text: failed ? 'Write failed.' : 'Wrote file.', ...(failed ? { isError: true } : {}) }] },
    }),
  ];
}

async function observeHistory(session: AgentSession, records: number): Promise<void> {
  const iterator = session.observe()[Symbol.asyncIterator]();
  for (let index = 0; index < records + 1; index += 1) await take(iterator);
}

class FakeOwnedAgent {
  readonly runtimeInfo: { status: 'idle' | 'running'; cwd: string; model: string };
  readonly features = {
    steer: true,
    cancel: true,
    readResource: true,
    interactions: { question: true, planApproval: true, toolApproval: true },
  };
  readonly messages: string[] = [];
  readonly steering: string[] = [];
  readonly responses: Array<{ requestId: string; response: AgentInteractionResponse }> = [];
  readonly imageReads: unknown[] = [];
  private readonly listeners = new Set<(record: DshNativeObservation) => void>();
  private records: DshNativeObservation[];
  onHistoryRead: (() => void) | undefined;

  constructor(
    readonly sessionId: string,
    events: readonly DshNativeObservation[] = [],
    cwd = '/workspace',
  ) {
    this.records = [...events];
    this.runtimeInfo = { status: 'idle', cwd, model: 'deepseek-chat' };
  }

  get events(): readonly DshNativeObservation[] {
    const onHistoryRead = this.onHistoryRead;
    this.onHistoryRead = undefined;
    onHistoryRead?.();
    return [...this.records];
  }

  subscribe(listener: (record: DshNativeObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(record: DshNativeObservation, append = true): void {
    if (append) this.records.push(record);
    for (const listener of this.listeners) listener(record);
  }

  followup(text: string): void {
    this.messages.push(text);
  }

  steer(text: string): void { this.steering.push(text); }
  cancel(): boolean { return true; }

  respondToInteraction(requestId: string, response: AgentInteractionResponse): boolean | Promise<boolean> {
    this.responses.push({ requestId, response });
    return true;
  }

  async readImage(reference: unknown) {
    this.imageReads.push(reference);
    return { data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' };
  }

  async flush(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class FakeRuntime implements DshRuntime {
  constructor(readonly agent: FakeOwnedAgent) {}
  async create(_config: AgentSessionConfig): Promise<DshOwnedAgent> { return this.agent as unknown as DshOwnedAgent; }
  async resume(_handle: AgentPersistenceHandle): Promise<DshOwnedAgent> { return this.agent as unknown as DshOwnedAgent; }
}

async function take(iterator: AsyncIterator<ProviderStreamItem>): Promise<ProviderStreamItem> {
  const result = await iterator.next();
  if (result.done) throw new Error('stream ended');
  return result.value;
}

describe('live DSH Provider session', () => {
  it('waits for the native response receipt and keeps a rejected asynchronous answer pending', async () => {
    const agent = new FakeOwnedAgent('session-1');
    const request: AgentInteractionRequest = { kind: 'tool_approval', requestId: 'approval-async',
      toolCallId: 'call-1', toolName: 'bash', summary: 'Run command', detail: { type: 'other', description: 'Run command' },
      allowedDecisions: ['allow', 'deny'], allowScopes: ['once'] };
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) }).createSession({ sessionId: 'session-1' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    await take(iterator);
    agent.emit(interaction('approval-async-record', request));
    await take(iterator);
    let resolve: ((accepted: boolean) => void) | undefined;
    agent.respondToInteraction = () => new Promise<boolean>((done) => { resolve = done; });
    let settled = false;
    const response = { kind: 'tool_approval' as const, decision: 'deny' as const };
    const answering = session.respondToInteraction(request.requestId, response).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolve?.(false);
    await expect(answering).rejects.toThrow('No pending DSH interaction');
    agent.respondToInteraction = async () => true;
    await expect(session.respondToInteraction(request.requestId, response)).resolves.toBeUndefined();
    await session.dispose();
  });
  it('subscribes before history and removes exact history/live overlap by native identity', async () => {
    const historical = sessionEvent(0, 'user/message', {
      id: 'message-1', turn: 'turn-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'History' }],
    }, 'overlap');
    const live = sessionEvent(1, 'assistant/message', {
      turn: 'turn-1', step: 1, message: { content: [{ type: 'text', text: 'Live' }] },
    }, 'live');
    const agent = new FakeOwnedAgent('session-1', [historical]);
    agent.onHistoryRead = () => {
      agent.emit(historical, false);
      agent.emit(live, false);
    };
    const provider = createLiveDshProvider({ runtime: new FakeRuntime(agent) });
    const session = await provider.createSession({ sessionId: 'session-1' });
    const iterator = session.observe()[Symbol.asyncIterator]();

    const history = await take(iterator);
    const boundary = await take(iterator);
    const liveItem = await take(iterator);

    expect(history).toMatchObject({ delivery: 'history', sourceKey: 'dsh:9:session-1:7:overlap' });
    expect(boundary).toEqual({ type: 'history_boundary' });
    expect(liveItem).toMatchObject({ delivery: 'live', sourceKey: 'dsh:9:session-1:4:live' });
    await session.dispose();
  });

  it('removes a cached pending interaction duplicated across history and the live overlap buffer', async () => {
    const request: AgentInteractionRequest = {
      kind: 'question',
      requestId: 'question-overlap',
      questions: [{
        questionId: 'language', header: 'Language', prompt: 'Choose a language', required: true,
        selection: 'single', options: [{ value: 'English', label: 'English' }],
        allowCustomText: true, allowDismiss: false,
      }],
    };
    const pending = interaction('question-overlap-record', request);
    const live = sessionEvent(0, 'assistant/message', {
      turn: 'turn-1', step: 1, message: { content: [{ type: 'text', text: 'Live' }] },
    });
    const agent = new FakeOwnedAgent('session-1', [pending]);
    agent.onHistoryRead = () => {
      agent.emit(pending, false);
      agent.emit(live, false);
    };
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-1' });
    const iterator = session.observe()[Symbol.asyncIterator]();

    const historicalRequest = await take(iterator);
    const boundary = await take(iterator);
    const liveItem = await take(iterator);

    expect(historicalRequest).toMatchObject({
      delivery: 'history', event: { type: 'interaction_requested', request },
    });
    expect(boundary).toEqual({ type: 'history_boundary' });
    expect(liveItem).toMatchObject({ delivery: 'live', event: { type: 'timeline' } });
    await session.dispose();
  });

  it('continues the native session through sendMessage and reports the stable Provider runtime', async () => {
    const agent = new FakeOwnedAgent('session-1');
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-1' });

    await session.sendMessage('Continue.');

    expect(agent.messages).toEqual(['Continue.']);
    expect(await session.runtimeInfo()).toEqual({
      providerId: 'dsh', sessionId: 'session-1', status: 'idle', cwd: '/workspace', model: 'deepseek-chat',
      persistence: { providerId: 'dsh', sessionId: 'session-1', opaque: 'dsh:session-1' },
    });
    await session.dispose();
  });

  it('routes immediate messages using the latest native status and leaves explicit steering unchanged', async () => {
    const agent = new FakeOwnedAgent('session-1');
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) }).createSession({ sessionId: 'session-1' });
    try {
      await session.sendMessage('idle');
      agent.runtimeInfo.status = 'running';
      await session.sendMessage('busy');
      await session.sendMessage('queued while busy', { delivery: 'next_turn' });
      agent.runtimeInfo.status = 'idle';
      await session.sendMessage('queued after turn ended', { delivery: 'next_turn' });
      await session.steer!('explicit steer while idle');
      expect(agent.messages).toEqual(['idle', 'queued while busy', 'queued after turn ended']);
      expect(agent.steering).toEqual(['busy', 'explicit steer while idle']);
      expect(session.capabilities.queueMessage).toBe(true);
    } finally { await session.dispose(); }
  });

  it('rejects busy immediate delivery when steering is unavailable without falling back to a queue', async () => {
    const agent = new FakeOwnedAgent('session-1');
    agent.features.steer = false;
    agent.runtimeInfo.status = 'running';
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) }).createSession({ sessionId: 'session-1' });
    try {
      await expect(session.sendMessage('urgent')).rejects.toThrow('steering');
      expect(agent.messages).toEqual([]);
      expect(agent.steering).toEqual([]);
      await session.sendMessage('later', { delivery: 'next_turn' });
      expect(agent.messages).toEqual(['later']);
    } finally { await session.dispose(); }
  });

  it('correlates typed interactions and rejects mismatched or stale responses', async () => {
    const agent = new FakeOwnedAgent('session-1');
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-1' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    await take(iterator);
    const request: AgentInteractionRequest = {
      kind: 'question',
      requestId: 'question-1',
      questions: [{
        questionId: 'language', header: 'Language', prompt: 'Choose a language', required: true,
        selection: 'single', options: [{ value: 'English', label: 'English' }],
        allowCustomText: true, allowDismiss: false,
      }],
    };
    agent.emit(interaction('question-request', request), false);

    expect(await take(iterator)).toMatchObject({ event: { type: 'interaction_requested', request } });
    await expect(session.respondToInteraction('question-1', { kind: 'plan_approval', action: 'approve' }))
      .rejects.toThrow('requires a question response');
    const answer: AgentInteractionResponse = {
      kind: 'question', answers: [{ questionId: 'language', selectedValues: ['English'] }],
    };
    await session.respondToInteraction('question-1', answer);
    await expect(session.respondToInteraction('question-1', answer)).rejects.toThrow('No pending DSH interaction question-1');
    expect(agent.responses).toEqual([{ requestId: 'question-1', response: answer }]);
    await session.dispose();
  });

  it('keeps a required question pending until it receives a non-empty selection or custom answer', async () => {
    const agent = new FakeOwnedAgent('session-1');
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-1' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    await take(iterator);
    const request: AgentInteractionRequest = {
      kind: 'question',
      requestId: 'required-question',
      questions: [{
        questionId: 'language', header: 'Language', prompt: 'Choose a language', required: true,
        selection: 'single', options: [{ value: 'English', label: 'English' }],
        allowCustomText: true, allowDismiss: false,
      }],
    };
    agent.emit(interaction('required-question-record', request), false);
    await take(iterator);

    await expect(session.respondToInteraction('required-question', {
      kind: 'question', answers: [],
    })).rejects.toThrow('requires an answer');
    await expect(session.respondToInteraction('required-question', {
      kind: 'question', answers: [{ questionId: 'language', selectedValues: [], customText: '   ' }],
    })).rejects.toThrow('requires an answer');
    expect(agent.responses).toEqual([]);

    const answer: AgentInteractionResponse = {
      kind: 'question', answers: [{ questionId: 'language', selectedValues: [], customText: 'Use English' }],
    };
    await session.respondToInteraction('required-question', answer);
    expect(agent.responses).toEqual([{ requestId: 'required-question', response: answer }]);
    await session.dispose();
  });

  it('advertises only evidenced interaction and resource capabilities', async () => {
    const agent = new FakeOwnedAgent('session-1');
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-1' });

    expect(session.capabilities).toEqual({
      commands: false,
      sessionSettings: false,
      planning: false,
      history: true,
      sendMessage: true,
      queueMessage: true,
      steer: true,
      cancel: true,
      readResource: true,
      interactions: { question: true, planApproval: true, toolApproval: true },
    });
    await session.dispose();
  });

  it('reads only complete image attachments already referenced by this session', async () => {
    const reference = {
      attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'plot.png',
    };
    const agent = new FakeOwnedAgent('session-1', [sessionEvent(0, 'assistant/message', {
      turn: 1, step: 1, message: { content: [{ type: 'image', attachment: reference }] },
    })]);
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-1' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    await take(iterator);
    await take(iterator);

    await expect(session.readResource?.('dsh-attachment:image-1')).resolves.toEqual({
      status: 'available', bytes: Uint8Array.of(1, 2, 3), mediaType: 'image/png',
    });
    await expect(session.readResource?.('dsh-attachment:other')).resolves.toEqual({
      status: 'unavailable', reason: 'Resource is not an image attachment referenced by this DSH session.',
    });
    expect(agent.imageReads).toEqual([reference]);
    await session.dispose();
  });

  it('reads only successful session-owned generated content and can stop that reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borgee-dsh-generated-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    const generated = join(workspace, 'generated-proof.txt');
    const unobserved = join(workspace, 'unobserved.txt');
    mkdirSync(workspace);
    writeFileSync(generated, 'DSH generated resource\n');
    writeFileSync(unobserved, 'not session owned\n');
    writeFileSync(outside, 'outside workspace\n');
    const agent = new FakeOwnedAgent(
      'session-generated',
      writeRecords('write-generated', 'generated-proof.txt', 'DSH generated resource\n'),
      workspace,
    );
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-generated' });
    await observeHistory(session, 2);

    try {
      await expect(session.readResource?.('generated-proof.txt')).resolves.toEqual({
        status: 'available', mediaType: 'text/plain', bytes: new TextEncoder().encode('DSH generated resource\n'),
      });
      await expect(session.readResource?.('unobserved.txt')).resolves.toMatchObject({ status: 'unavailable' });
      await expect(session.readResource?.('../outside.txt')).resolves.toMatchObject({ status: 'unavailable' });
      await expect(session.readResource?.(outside)).resolves.toMatchObject({ status: 'unavailable' });

      session.stopGeneratedResourceReader();
      await expect(session.readResource?.('generated-proof.txt')).resolves.toEqual({
        status: 'unavailable', reason: 'DSH generated-resource reader is stopped.',
      });
    } finally {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not retain one generated-resource byte buffer per hydrated revision', async () => {
    const content = 'x'.repeat(512 * 1024);
    const records = Array.from({ length: 12 }, (_, index) => (
      writeRecords(`write-${index}`, `generated-${index}.txt`, content, false, index * 2)
    )).flat();
    const agent = new FakeOwnedAgent('session-many-generated', records);
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-many-generated' });
    const before = process.memoryUsage().arrayBuffers;

    session.observe();

    const retained = process.memoryUsage().arrayBuffers - before;
    expect(retained).toBeLessThan(content.length);
    await session.dispose();
  });

  it('retains fixed-size fingerprints instead of historical payload text for overlap detection', async () => {
    const content = 'payload-marker-'.repeat(4_096);
    const records = writeRecords('write-fingerprint', 'generated-proof.txt', content);
    const agent = new FakeOwnedAgent('session-fingerprint', records);
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-fingerprint' });

    session.observe();

    const seen = (session as unknown as { seen: Map<string, string> }).seen;
    expect([...seen.values()]).toHaveLength(records.length);
    expect([...seen.values()]).toEqual(records.map(() => expect.stringMatching(/^[a-f0-9]{64}$/)));
    await session.dispose();
  });

  it('keeps a generated revision retryable after a transient native history read failure', async () => {
    const records = writeRecords('write-retry', 'generated-proof.txt', 'retryable bytes\n');
    const agent = new FakeOwnedAgent('session-reader-retry', records);
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-reader-retry' });
    const iterator = session.observe()[Symbol.asyncIterator]();
    await take(iterator);
    const completion = await take(iterator);
    await take(iterator);
    if (completion.type !== 'observation') throw new Error('Expected the write completion observation.');
    const readLocator = completion.resourceReferences?.[0]?.readLocator;
    if (!readLocator) throw new Error('Expected a Provider read locator.');
    agent.onHistoryRead = () => { throw new Error('Native history is temporarily unavailable.'); };

    await expect(session.readResource?.(readLocator)).rejects.toThrow('Native history is temporarily unavailable.');
    await expect(session.readResource?.(readLocator)).resolves.toEqual({
      status: 'available', mediaType: 'text/plain', bytes: new TextEncoder().encode('retryable bytes\n'),
    });
    await session.dispose();
  });

  it('captures declared write bytes without following a pre-existing symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borgee-dsh-generated-symlink-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    mkdirSync(workspace);
    writeFileSync(outside, 'host secret\n');
    symlinkSync(outside, join(workspace, 'generated-proof.txt'));
    const agent = new FakeOwnedAgent(
      'session-symlink',
      writeRecords('write-symlink', 'generated-proof.txt', 'declared bytes\n'),
      workspace,
    );
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-symlink' });
    await observeHistory(session, 2);

    try {
      await expect(session.readResource?.('generated-proof.txt')).resolves.toEqual({
        status: 'available', mediaType: 'text/plain', bytes: new TextEncoder().encode('declared bytes\n'),
      });
    } finally {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps captured bytes when the generated path is swapped to an outside symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borgee-dsh-generated-swap-'));
    const workspace = join(root, 'workspace');
    const generated = join(workspace, 'generated-proof.txt');
    const outside = join(root, 'outside.txt');
    mkdirSync(workspace);
    writeFileSync(generated, 'captured bytes\n');
    writeFileSync(outside, 'host secret\n');
    const agent = new FakeOwnedAgent(
      'session-swap',
      writeRecords('write-swap', 'generated-proof.txt', 'captured bytes\n'),
      workspace,
    );
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-swap' });
    await observeHistory(session, 2);
    rmSync(generated);
    symlinkSync(outside, generated);

    try {
      await expect(session.readResource?.('generated-proof.txt')).resolves.toEqual({
        status: 'available', mediaType: 'text/plain', bytes: new TextEncoder().encode('captured bytes\n'),
      });
    } finally {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps captured bytes when the generated path is replaced with oversized content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borgee-dsh-generated-grow-'));
    const workspace = join(root, 'workspace');
    const generated = join(workspace, 'generated-proof.txt');
    mkdirSync(workspace);
    writeFileSync(generated, 'captured bytes\n');
    const agent = new FakeOwnedAgent(
      'session-grow',
      writeRecords('write-grow', 'generated-proof.txt', 'captured bytes\n'),
      workspace,
    );
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-grow' });
    await observeHistory(session, 2);
    writeFileSync(generated, 'x'.repeat((16 * 1024 * 1024) + 1));

    try {
      await expect(session.readResource?.('generated-proof.txt')).resolves.toEqual({
        status: 'available', mediaType: 'text/plain', bytes: new TextEncoder().encode('captured bytes\n'),
      });
    } finally {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not authorize oversized or empty declared write content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borgee-dsh-generated-bounds-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'oversized.txt'), 'small filesystem value\n');
    writeFileSync(join(workspace, 'empty.txt'), 'non-empty filesystem value\n');
    const records = [
      ...writeRecords('write-oversized', 'oversized.txt', 'x'.repeat((16 * 1024 * 1024) + 1)),
      ...writeRecords('write-empty', 'empty.txt', '').map((record, index) => ({
        ...record,
        recordId: `empty-${index}`,
        payload: { ...(record.payload as object), seq: index + 2 },
      })),
    ];
    const agent = new FakeOwnedAgent('session-bounds', records, workspace);
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-bounds' });
    await observeHistory(session, 4);

    try {
      await expect(session.readResource?.('oversized.txt')).resolves.toMatchObject({ status: 'unavailable' });
      await expect(session.readResource?.('empty.txt')).resolves.toMatchObject({ status: 'unavailable' });
    } finally {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates captured content when a later successful write to the same locator is empty', async () => {
    const records = [
      ...writeRecords('write-valid', 'generated-proof.txt', 'captured bytes\n'),
      ...writeRecords('write-empty', 'generated-proof.txt', '', false, 2),
    ];
    const agent = new FakeOwnedAgent('session-empty-replacement', records);
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-empty-replacement' });
    await observeHistory(session, records.length);

    await expect(session.readResource?.('generated-proof.txt')).resolves.toMatchObject({ status: 'unavailable' });
    await session.dispose();
  });

  it('invalidates captured content when a later successful write to the same locator is oversized', async () => {
    const records = [
      ...writeRecords('write-valid', 'generated-proof.txt', 'captured bytes\n'),
      ...writeRecords('write-oversized', 'generated-proof.txt', 'x'.repeat((16 * 1024 * 1024) + 1), false, 2),
    ];
    const agent = new FakeOwnedAgent('session-oversized-replacement', records);
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-oversized-replacement' });
    await observeHistory(session, records.length);

    await expect(session.readResource?.('generated-proof.txt')).resolves.toMatchObject({ status: 'unavailable' });
    await session.dispose();
  });

  it('preserves captured content when a later write to the same locator fails', async () => {
    const records = [
      ...writeRecords('write-valid', 'generated-proof.txt', 'captured bytes\n'),
      ...writeRecords('write-failed', 'generated-proof.txt', 'rejected bytes\n', true, 2),
    ];
    const agent = new FakeOwnedAgent('session-failed-replacement', records);
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-failed-replacement' });
    await observeHistory(session, records.length);

    await expect(session.readResource?.('generated-proof.txt')).resolves.toEqual({
      status: 'available', mediaType: 'text/plain', bytes: new TextEncoder().encode('captured bytes\n'),
    });
    await session.dispose();
  });

  it('does not authorize content from a failed write completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borgee-dsh-generated-failed-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'failed.txt'), 'filesystem value\n');
    const agent = new FakeOwnedAgent(
      'session-failed',
      writeRecords('write-failed', 'failed.txt', 'declared bytes\n', true),
      workspace,
    );
    const session = await createLiveDshProvider({ runtime: new FakeRuntime(agent) })
      .createSession({ sessionId: 'session-failed' });
    await observeHistory(session, 2);

    try {
      await expect(session.readResource?.('failed.txt')).resolves.toMatchObject({ status: 'unavailable' });
    } finally {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
