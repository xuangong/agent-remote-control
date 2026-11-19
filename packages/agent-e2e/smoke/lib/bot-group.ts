import { randomUUID } from 'node:crypto';
import { createWindowView, type WindowGroupEdit } from '@orchardworks/agent-remote-protocol';
import { signInLocalUser } from '../../stack/owner.js';

/** A group on the instance (a Window of docked sessions; with `asBots` also a section for Bot mode), created and edited as its local user through the Relay's Window requests; one sign-in for all edits. */
export interface BotGroup {
  id: string;
  /** The view of the bot of each session, by the session's native id. */
  viewOf(nativeSessionId: string): string;
  /** Applies one group edit on top of the group's current revision. */
  edit(operation: WindowGroupEdit | { type: 'batch'; operations: WindowGroupEdit[] }): Promise<void>;
  /** Deletes the group and signs out. */
  close(): Promise<void>;
}

export async function createBotGroup(origin: string, { id, title, hostId, providerId, sessions, asBots = true }: { asBots?: boolean; id: string; title: string; hostId: string; providerId: string; sessions: Array<{ nativeSessionId: string; title: string }> }): Promise<BotGroup> {
  const user = await signInLocalUser(origin);
  const views = new Map(sessions.map(session => [session.nativeSessionId, `bot-${session.nativeSessionId}`]));
  const window = { schemaVersion: 3 as const, id, title, revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', undefined, 'primary'), ...sessions.map(session => createWindowView(views.get(session.nativeSessionId)!, { hostId, providerId, nativeSessionId: session.nativeSessionId, title: session.title }))] };
  const created = await user.request('POST', 'v1/windows', { operationId: randomUUID(), issuedAt: Date.now(), window, ...(asBots ? { bots: { rank: 'm', members: {} } } : {}) });
  if (!created.ok) throw new Error(`The group was refused (${created.status}): ${(await created.text()).slice(0, 300)}`);
  const revision = async () => ((await (await user.request('GET', `v1/windows/${encodeURIComponent(id)}`)).json()) as { window: { revision: number } }).window.revision;
  return {
    id,
    viewOf: nativeSessionId => views.get(nativeSessionId)!,
    async edit(operation) {
      const response = await user.request('POST', `v1/windows/${encodeURIComponent(id)}/operations`, { operationId: randomUUID(), issuedAt: Date.now(), baseRevision: await revision(), operation });
      if (!response.ok) throw new Error(`The group edit ${operation.type} was refused (${response.status}): ${(await response.text()).slice(0, 300)}`);
    },
    async close() {
      try { await user.request('DELETE', `v1/windows/${encodeURIComponent(id)}`, { operationId: randomUUID(), issuedAt: Date.now(), baseRevision: await revision(), operation: { type: 'delete' } }); }
      finally { await user.close(); }
    },
  };
}
