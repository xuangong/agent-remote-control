import { isSuccessionActionResult, isSuccessionDescription, type SuccessionDescription } from '@orchardworks/agent-remote-protocol';
import type { OpenedSession } from '../../agent-remote-lab/src/directory-client.js';
import type { SessionSuccessionDirectory } from '../../agent-remote-lab/src/session-succession-directory.js';
import type { DebuggerSession } from '../src/server.js';

export type LiveSession = OpenedSession & Pick<DebuggerSession, 'draftOwnerId'>;

async function post(action: string, body: unknown): Promise<unknown> {
  const response = await fetch(`/__ardb/succession/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `The local operation failed (${response.status}).`);
  return value;
}
export async function describeLiveSession(source: OpenedSession): Promise<SuccessionDescription> {
  const value = await post('describe', { agentId: source.agentId });
  if (!isSuccessionDescription(value)) throw new Error('The local current role could not be verified.');
  return value;
}

/** ARDB translates only its owned local route; operation recovery stays in the shared view. */
export function ardbSessionDirectory(source: OpenedSession): SessionSuccessionDirectory {
  let description: SuccessionDescription | undefined;
  return {
    async describeSuccession(providerId, nativeSessionId, preparation) {
      if (source.providerId !== providerId || source.nativeSessionId !== nativeSessionId) throw new Error('The local prompt source changed.');
      const value = await post('describe', { agentId: source.agentId, ...(preparation ? { preparation } : {}) });
      if (!isSuccessionDescription(value)) throw new Error('The local prefix capability could not be verified.');
      description = value; return value;
    },
    async prepareSuccession(input) {
      if (!description || description.role.current.providerId !== input.providerId || description.role.current.nativeSessionId !== input.nativeSessionId
        || description.role.revision !== input.expectedRevision) throw new Error('The local prompt source changed before preparation.');
      const value = await post('prepare', { operationId: input.operationId, roleId: description.role.id, expectedRevision: input.expectedRevision,
        from: description.role.current, ...(input.targetProviderId ? { targetProviderId: input.targetProviderId } : {}), preparation: input.preparation });
      if (!isSuccessionActionResult(value)) throw new Error('The local prompt preparation could not be verified. Check the original operation.');
      return value;
    },
    async actOnSuccession(action, retained) {
      const value = await post(action, { operationId: retained.operationId, expectedRevision: retained.expectedRevision });
      if (!isSuccessionActionResult(value)) throw new Error('The local prompt outcome could not be verified.');
      return value;
    },
  };
}
