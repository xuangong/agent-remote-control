import { createHash } from 'node:crypto';
import { nativeSessionRefKey, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
/** Stable identity shared by complete enrollment and exact relation updates. */
export const sourceParticipantId = (reader: NativeSessionRef, relationId: string): string =>
  `source:${createHash('sha256').update(JSON.stringify([nativeSessionRefKey(reader), relationId])).digest('hex')}`;
