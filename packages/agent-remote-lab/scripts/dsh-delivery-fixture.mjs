import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

// Resolve from the native installation so this fixture shares its LLM contract.
const require = createRequire(resolve(process.env.DSH_REPO, 'packages/core/agent/package.json'));
const { LlmAdapter, ToolCallId } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);

function record(value) {
  if (process.env.AGENT_REMOTE_DSH_DELIVERY_EVIDENCE) {
    appendFileSync(process.env.AGENT_REMOTE_DSH_DELIVERY_EVIDENCE, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }
}

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

class DeliveryAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }

  async *stream(options) {
    const userText = options.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(block => block.type === 'text' && block.text.startsWith('REMOTE_')).map(block => block.text)).join('\n');
    if (!userText) { yield* textChunks('Remote delivery verification'); return; }
    record({ kind: 'model-request', userText });
    if (userText.includes('REMOTE_HOLD')) {
      try { await setTimeout(60_000, undefined, { signal: options.signal }); }
      catch (error) { record({ kind: 'model-aborted' }); throw error; }
      yield* textChunks('HOLD_NOT_INTERRUPTED');
      return;
    }
    const hasRead = options.messages.some(message => message.content.some(block => block.type === 'tool-result'));
    if (!hasRead) {
      // Hold the first model step while the browser submits both delivery modes.
      await setTimeout(8_000, undefined, { signal: options.signal });
      const id = ToolCallId('remote-delivery-read');
      const args = JSON.stringify({ file_path: 'live-fixture.txt' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'read', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield* textChunks(userText.includes('REMOTE_QUEUED') ? 'QUEUED_TURN_CONSUMED' : 'IMMEDIATE_STEP_CONSUMED');
  }
}

export const name = 'remote-delivery-fixture';
export const inject = ['llm'];
export function apply(ctx) {
  ctx.llm.registerAdapter(['remote-delivery-fixture'], new DeliveryAdapter());
  ctx.on('session/event', (session, event) => {
    if (['turn/start', 'turn/end', 'agent/inbox/spliced'].includes(event.type)
      || (event.type === 'user/message' && event.data.source?.kind === 'user')) {
      record({ kind: 'native-event', sessionId: session.id, event });
    }
  });
}
