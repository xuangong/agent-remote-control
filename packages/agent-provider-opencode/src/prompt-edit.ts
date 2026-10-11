import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { IMAGE_INPUT_CAPABILITIES } from '@orchardworks/agent-provider-sdk';
import { OpenCodeImages } from './images.js';
import { nativeHistory } from './native-history.js';
import { turnIds } from './v2-native.js';
import type { OpenCodeTransport } from './transport.js';

export interface OpenCodePromptEditTarget { nativeSessionId: string; turnId: string; messageId: string }

/** The native fork endpoint copies the prefix strictly before a message without reverting files. */
export async function preparePromptEdit(transport: OpenCodeTransport, target: OpenCodePromptEditTarget) {
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
  // Check current activity after the bounded history read, which can span several pages.
  const parameters = { sessionID: target.nativeSessionId };
  const [active, permissions, forms, inbox] = await Promise.all([
    transport.request(() => transport.client.session.active()),
    transport.request(() => transport.client.permission.list(parameters)),
    transport.request(() => transport.client.session.form.list(parameters)),
    transport.request(() => transport.client.session.inbox.list(parameters)),
  ]);
  if (active[target.nativeSessionId]) throw new Error('Wait for the native OpenCode session to finish before editing a prompt.');
  if (permissions.length || forms.length || inbox.length) throw new Error('Resolve pending OpenCode interactions and queued input before editing a prompt.');
  // Native fork reconstructs model and agent selections at its boundary; its snapshot confirms them.
  return { cwd };
}
