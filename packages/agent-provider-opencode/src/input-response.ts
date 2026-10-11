import { isDeepStrictEqual } from 'node:util';
import type { SessionInfo as Session } from '@opencode/client';
import type { OpenCodeTransport } from './transport.js';
import { nativeSelections } from './settings.js';
import { nativeHistory } from './native-history.js';
import type { NativeInput } from './v2-native.js';

/** Native sequence can settle ordinary input execution without claiming historical settings. */
export async function readOpenCodeInputResponse(transport: OpenCodeTransport, sessionID: string, inputID: string, expected: NativeInput, current: () => boolean): Promise<string | undefined> {
  if (!current()) return;
  const messages = await nativeHistory(transport, sessionID);
  if (!current()) return;
  const index = messages.findIndex(message => message.id === inputID);
  const user = messages[index], response = messages[index + 1];
  if (index < 0 || user?.type !== 'user' || user.text !== expected.text
    || (user.files?.length ?? 0) !== (expected.files?.length ?? 0) || user.agents?.length || user.skills?.length
    || user.metadata && Object.keys(user.metadata).length || response?.type !== 'assistant') return;
  for (const [index, file] of (user.files ?? []).entries()) {
    const original = expected.files![index]!;
    const inline = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(original.uri);
    if (!inline || file.mime !== inline[1] || file.data !== inline[2]
      || file.name !== original.name || file.description !== original.description || !isDeepStrictEqual(file.mention, original.mention)
      || file.source.type !== 'inline' && !(file.source.type === 'uri' && file.source.uri === original.uri)) return;
  }
  // Any intervening native record breaks causality, including control changes and synthetic input.
  if (typeof response.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(response.id)) return;
  if (!nativeSelections({ agent: response.agent, model: response.model } as Session)) return;
  return response.id;
}
