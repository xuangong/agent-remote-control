import { withMessageKey } from '@orchardworks/agent-client';
/**
 * Child session plan: how a subagent (child) session of a parent opens.
 *
 * Contract
 * - Pure. The shell passes the session lists and what the Host answered; it performs the opening.
 * - `childOpensBeside`: with a shared Window, or on a desktop layout, the child opens as a Side of its parent. On a
 *   compact layout without a shared Window it replaces the shown session instead.
 * - `directParentOf`: a child the directory knows under another parent than the shown one is opened from its direct
 *   parent, which must be open. Without a recorded parent, or with the shown one, the shown session stays the origin.
 *   A missing direct parent is an error, never a guess.
 * - `besideChildSession` and `replacingChildSession` build the opened child. The Side keeps the origin's host and
 *   provider and names the origin as its parent. The replacing child takes the Host's native id, and its parent is
 *   the recorded one, falling back to the origin.
 * - `childRequestCurrent`: an answer is used only while the workspace generation is the one the request started in and
 *   (for a Side) no later Side request of the same source superseded it.
 */
export interface ChildIdentity {
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly hostId?: string;
  readonly parentNativeSessionId?: string;
  readonly parentAgentId?: string;
}

const sameWorkspace = (a: ChildIdentity, b: ChildIdentity) => a.providerId === b.providerId && (a.hostId ?? 'local') === (b.hostId ?? 'local');

export function childOpensBeside(layout: { readonly sharedWindow: boolean; readonly compact: boolean }): boolean {
  return layout.sharedWindow || !layout.compact;
}

export function knownChildOf<Entry extends ChildIdentity>(entries: readonly Entry[], childNativeSessionId: string, origin: ChildIdentity): Entry | undefined {
  return entries.find(entry => entry.nativeSessionId === childNativeSessionId && sameWorkspace(entry, origin));
}

export function directParentOf<Open extends ChildIdentity>(origin: Open, known: ChildIdentity | undefined, open: readonly Open[]): Open {
  if (!known?.parentNativeSessionId || known.parentNativeSessionId === origin.nativeSessionId) return origin;
  const parent = open.find(session => session.nativeSessionId === known.parentNativeSessionId && sameWorkspace(session, origin));
  if (!parent) throw withMessageKey(new Error('Open the direct parent session before opening this nested subagent.'), 'client.fork.parentFirst');
  return parent;
}

export function besideChildSession<Child extends { readonly nativeSessionId: string }>(
  child: Child, origin: ChildIdentity & { readonly agentId: string }, agentId: string,
) {
  return { ...child, agentId, providerId: origin.providerId, hostId: origin.hostId, parentAgentId: origin.agentId, parentNativeSessionId: origin.nativeSessionId };
}

export function replacingChildSession(
  child: { readonly title: string; readonly createdAt?: string }, origin: ChildIdentity & { readonly agentId: string },
  known: ChildIdentity | undefined, result: { readonly agentId: string; readonly nativeSessionId: string },
) {
  const hostId = origin.hostId ?? 'local';
  const parentNativeSessionId = known?.parentNativeSessionId ?? origin.nativeSessionId;
  return { agentId: result.agentId, providerId: origin.providerId, nativeSessionId: result.nativeSessionId, title: child.title, createdAt: child.createdAt,
    hostId, parentAgentId: known?.parentAgentId ?? origin.agentId, parentNativeSessionId };
}

export function childRequestCurrent(request: { readonly generation: number; readonly side?: { readonly issued: unknown; readonly latest: unknown } }, generation: number): boolean {
  return request.generation === generation && (!request.side || request.side.issued === request.side.latest);
}
