import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';

/** Deterministic native adapter fixture, shared by transport and installed-package tests. */
export function createBrowserPrefixAdapter(directory) {
  const attached = new Map();
  let settleInput, pendingInput;
  const path = join(directory, 'native.json');
  const state = async () => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { creates: 0, forks: 0, sessions: {} }; throw error; } };
  const save = value => writeFile(path, JSON.stringify(value));
  const handle = id => ({ providerId: 'prefix-fixture', sessionId: id, opaque: JSON.stringify({ cwd: directory, exact: id }) });
  async function open(id, extensions = {}) {
    if (attached.has(id)) throw new Error('Already attached');
    let closed = false, wake;
    const token = {};
    const queue = [];
    const original = (await state()).sessions[id];
    if (!original) throw new Error('Native identity missing');
    const runtimeInfo = async () => ({ providerId: 'prefix-fixture', sessionId: id, status: 'idle', cwd: directory, persistence: handle(id) });
    const session = {
      capabilities: { history: true, sendMessage: true, steer: false, cancel: true, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
      promptEditEvidence: { version: 1, inspectReadiness: async () => ({ cwd: directory, idle: !closed, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 }), captureValidity: () => token, isCurrent: value => value === token && !closed },
      runtimeInfo,
      async *observe() {
        for (const [index, text] of original.texts.entries()) yield { type: 'observation', sourceKey: `${id}-${index}`, delivery: 'history', occurredAt: 1 + index,
          event: { type: 'timeline', provider: 'prefix-fixture', turnId: `turn-${index}`, item: { type: 'user_message', messageId: `message-${index}`, text } } };
        yield { type: 'history_boundary' };
        while (!closed) { if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; }); }
      },
      async sendMessage(text) {
        if (text === 'echo before ACK' || text === 'rejected draft') {
          queue.push({ type: 'observation', sourceKey: `${id}-echo-${Date.now()}`, delivery: 'live', occurredAt: Date.now(), event: { type: 'timeline', provider: 'prefix-fixture', turnId: `input-${text}`, item: { type: 'user_message', messageId: `echo-${text}`, text } } });
          wake?.();
          await new Promise((resolve, reject) => { pendingInput = text; settleInput = accepted => { pendingInput = undefined; return accepted ? resolve() : reject(new AgentOperationRejectedError('fixture_rejected', 'Fixture admission rejected.')); }; });
        }
        const current = await state(); current.sessions[id].inputs.push(text); await save(current); return { disposition: 'handled' }; },
      async cancel() {}, async respondToInteraction() {},
      async dispose() { closed = true; attached.delete(id); wake?.(); },
      readSource: args => extensions.tools?.find(tool => tool.name === 'read_source_session')?.execute(args),
    };
    attached.set(id, session); return session;
  }
  const adapter = {
    descriptor: { providerId: 'prefix-fixture', displayName: 'Native prefix fixture', sessionExtensions: { instructions: true, tools: true } },
    createdSessionIdMaxLength: 100,
    async createSession(config) {
      const current = await state(), id = config.sessionId; current.creates++;
      current.sessions[id] = { texts: ['original history', 'selected prompt', 'discarded tail'], inputs: [] }; await save(current);
      return open(id, config);
    },
    async resumeSession(value, extensions) {
      if (JSON.stringify(value) !== JSON.stringify(handle(value.sessionId))) throw new Error('Wrong exact native handle');
      return open(value.sessionId, extensions);
    },
    async validatePromptEdit(target) { if (!(await state()).sessions[target.nativeSessionId] || target.turnId !== 'turn-1' || target.messageId !== 'message-1') throw new Error('Invalid selection'); },
    // Non-durable convenience calls deliberately omit a checkpoint.
    async forkForPromptEdit(target, extensions) { return createPrefix(target, extensions); },
    async verifyPromptEditBranch(target, value) {
      if (value.sessionId === target.nativeSessionId || JSON.stringify(value) !== JSON.stringify(handle(value.sessionId)) || (await state()).sessions[value.sessionId]?.texts.join() !== 'original history') throw new Error('Prefix readback mismatch');
    },
    async readSessionHistory(id) { return { entries: (await state()).sessions[id].texts.map((text, index) => ({ id: String(index), turnId: 'turn', role: 'user', text, textOffset: 0, totalChars: text.length })) }; },
    state, pendingInput: () => pendingInput, settleInput(accepted) { const settle = settleInput; settleInput = undefined; settle?.(accepted); }, async unknown() { const current = await state(); current.unknown = true; await save(current); },
    readSource: (id, args) => attached.get(id)?.readSource(args),
    async dispose() { await Promise.all([...attached.values()].map(session => session.dispose())); },
  };
  async function createPrefix(target, extensions, checkpoint) {
    const current = await state(); current.forks++; await save(current);
    if (current.unknown) throw new Error('Native fork outcome unknown');
    const id = `candidate-${current.forks}`; current.sessions[id] = { texts: ['original history'], inputs: [] }; await save(current);
    await checkpoint?.(handle(id));
    return open(id, extensions);
  }
  adapter.nativePrefix = {
    createdSessionIdMaxLength: 100,
    validate: target => adapter.validatePromptEdit(target),
    create(target, extensions, checkpoint) {
      if (typeof checkpoint !== 'function') return Promise.reject(new Error('Native prefix creation requires a checkpoint.'));
      return createPrefix(target, extensions, checkpoint);
    },
    verify: (target, value) => adapter.verifyPromptEditBranch(target, value),
  };
  return adapter;
}
