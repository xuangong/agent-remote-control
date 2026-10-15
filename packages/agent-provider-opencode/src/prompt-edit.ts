import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';
import { readPromptEditReadiness } from './prompt-edit-evidence.js';
import { IMAGE_INPUT_CAPABILITIES } from '@orchardworks/agent-provider-sdk';
import { OpenCodeImages } from './images.js';
import { nativeHistory } from './native-history.js';
import { turnIds } from './v2-native.js';
import type { OpenCodeTransport } from './transport.js';

export interface OpenCodePromptEditTarget { nativeSessionId: string; turnId: string; messageId: string }

/** The native fork endpoint copies the prefix strictly before a message without reverting files. */
async function readPromptEditSource(transport: OpenCodeTransport, target: OpenCodePromptEditTarget) {
  if (!target.nativeSessionId || !target.messageId || target.turnId !== target.messageId) throw new Error('The selected OpenCode prompt identity is invalid.');
  const native = await transport.request(() => transport.client.session.get({ sessionID: target.nativeSessionId }));
  if (native.id !== target.nativeSessionId) throw new Error('The source OpenCode session is unavailable.');
  if (native.parentID) throw new Error('Editing prompts in native child conversations is unavailable.');
  if (native.revert) throw new Error('Resolve the native OpenCode revert before editing this prompt.');
  const cwd = await realpath(resolve(native.location.directory));
  const messages = await nativeHistory(transport, target.nativeSessionId);
  const message = messages.find(value => value.id === target.messageId);
  const turns = turnIds(messages, { startsAtBeginning: true });
  if (message?.type !== 'user' || turns.get(message.id) !== message.id) throw new Error('Only the first user prompt of a turn is editable; the selected message is missing or is a mid-turn steer.');
  const files = message.files ?? [];
  const unsupported = () => new Error('This prompt contains native input bindings that cannot be restored in the web composer.');
  if (message.agents?.length || message.skills?.length || (!message.text && !files.length) || files.length > IMAGE_INPUT_CAPABILITIES.maxImages ||
    files.some(file => !IMAGE_INPUT_CAPABILITIES.mediaTypes.some(mime => mime === file.mime))) throw unsupported();
  const images = new OpenCodeImages(target.nativeSessionId);
  try {
    const projected = images.project(message.id, files.map((file, index) => ({ key: `file:${index}`, mime: file.mime, data: file.data, name: file.name })));
    let bytes = Buffer.byteLength(message.text);
    for (const reference of projected.references) {
      const resource = await images.read(reference.locator);
      if (resource.status !== 'available') throw unsupported();
      bytes += resource.bytes.byteLength;
    }
    if (projected.references.length !== files.length || bytes > IMAGE_INPUT_CAPABILITIES.maxMessageBytes) throw unsupported();
  } finally { images.close(); }
  return { cwd, prefix: messages.slice(0, messages.indexOf(message)) };
}
export async function preparePromptEdit(transport: OpenCodeTransport, target: OpenCodePromptEditTarget) {
  const { cwd } = await readPromptEditSource(transport, target);
  // Check activity after the bounded complete history read.
  const readiness = await readPromptEditReadiness(transport, target.nativeSessionId, cwd);
  if (!readiness.idle) throw new Error('Wait for the native OpenCode session to finish before editing a prompt.');
  if (readiness.pendingInputs || readiness.pendingInteractions) throw new Error('Resolve pending OpenCode interactions and queued input before editing a prompt.');
  if (readiness.activeChildren) throw new Error('Wait for native OpenCode child sessions to finish before editing a prompt.');
  return { cwd };
}
/** Branch content inspection is read-only and does not decide source commit authority. */
export async function verifyPromptEditBranch(transport: OpenCodeTransport, target: OpenCodePromptEditTarget, handle: AgentPersistenceHandle): Promise<void> {
  if (handle.providerId !== 'opencode' || !handle.sessionId || handle.sessionId === target.nativeSessionId) throw new Error('Invalid OpenCode prompt-edit candidate identity.');
  const stored: unknown = JSON.parse(handle.opaque);
  if (!stored || typeof stored !== 'object' || !('cwd' in stored) || typeof stored.cwd !== 'string') throw new Error('OpenCode candidate workspace is unavailable.');
  const { cwd, prefix } = await readPromptEditSource(transport, target);
  const native = await transport.request(() => transport.client.session.get({ sessionID: handle.sessionId }));
  if (native.id !== handle.sessionId || native.parentID || native.revert || await realpath(resolve(native.location.directory)) !== cwd
    || await realpath(resolve(stored.cwd)) !== cwd) throw new Error('OpenCode candidate identity or workspace does not match.');
  const actual = await nativeHistory(transport, handle.sessionId);
  if (!isDeepStrictEqual(actual, prefix)) throw new Error('OpenCode candidate does not contain the exact native prompt-edit prefix.');
}
