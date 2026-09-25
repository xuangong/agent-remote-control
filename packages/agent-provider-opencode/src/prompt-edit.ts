import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OpenCodeTransport } from './transport.js';

export interface OpenCodePromptEditTarget { nativeSessionId: string; turnId: string; messageId: string }

/** The native fork endpoint copies the prefix strictly before messageID without reverting files. */
export async function preparePromptEdit(transport: OpenCodeTransport, target: OpenCodePromptEditTarget) {
  if (!target.nativeSessionId || !target.messageId || target.turnId !== target.messageId) throw new Error('The selected OpenCode prompt identity is invalid.');
  const native = await transport.request(() => transport.client.session.get({ sessionID: target.nativeSessionId }));
  if (native.id !== target.nativeSessionId) throw new Error('The source OpenCode session is unavailable.');
  if (native.parentID) throw new Error('Editing prompts in native child conversations is unavailable.');
  if (native.revert) throw new Error('Resolve the native OpenCode revert before editing this prompt.');
  const cwd = await realpath(resolve(native.directory));
  const [message, statuses, permissions, questions] = await Promise.all([
    transport.request(() => transport.client.session.message({ sessionID: target.nativeSessionId, messageID: target.messageId, directory: cwd })),
    transport.request(() => transport.client.session.status({ directory: cwd })),
    transport.request(() => transport.client.permission.list({ directory: cwd })),
    transport.request(() => transport.client.question.list({ directory: cwd })),
  ]);
  if (statuses[target.nativeSessionId]?.type === 'busy' || statuses[target.nativeSessionId]?.type === 'retry') throw new Error('Wait for the native OpenCode session to finish before editing a prompt.');
  if (permissions.some(request => request.sessionID === target.nativeSessionId) || questions.some(request => request.sessionID === target.nativeSessionId)) throw new Error('Resolve pending OpenCode interactions before editing a prompt.');
  if (message.info.id !== target.messageId || message.info.sessionID !== target.nativeSessionId || message.info.role !== 'user') throw new Error('The selected message is not an editable user prompt.');
  if (!message.parts.length || message.parts.some(part => part.type === 'text' ? part.synthetic || part.ignored : part.type !== 'file' || !part.mime.startsWith('image/'))) {
    throw new Error('This prompt contains native input bindings that cannot be restored in the web composer.');
  }
  const model = message.info.model ? `${message.info.model.providerID}/${message.info.model.modelID}` : undefined;
  return { cwd, model, agent: message.info.agent };
}
