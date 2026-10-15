import type { NativePrefixSelection, SuccessionActionResult, SuccessionDescription } from '@orchardworks/agent-remote-protocol';
import type { SessionDirectoryClient, SuccessionPrepareInput } from './directory-client.js';

/** The dialog owns the retained identity; each embedder owns its wire encoding. */
export interface SessionSuccessionDirectory {
  describeSuccession(providerId: string, nativeSessionId: string, preparation?: NativePrefixSelection): Promise<SuccessionDescription>;
  prepareSuccession(input: SuccessionPrepareInput): Promise<SuccessionActionResult>;
  actOnSuccession(action: 'commit' | 'cancel' | 'status' | 'reconcile', retained: Readonly<SuccessionPrepareInput>): Promise<SuccessionActionResult>;
}

export function labSessionSuccessionDirectory(client: SessionDirectoryClient): SessionSuccessionDirectory {
  return {
    describeSuccession: (providerId, nativeSessionId, preparation) => client.describeSuccession(providerId, nativeSessionId, preparation),
    prepareSuccession: input => client.prepareSuccession(input),
    actOnSuccession: (action, retained) => action === 'cancel'
      ? client.successionAction(action, retained.operationId, { original: retained })
      : client.successionAction(action, retained.operationId),
  };
}
