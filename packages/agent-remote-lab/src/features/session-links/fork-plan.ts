/**
 * Fork plan: how a conversation command (`/fork`, `/side`, `/ask`) becomes a new session, and when a saved Side opens.
 *
 * Contract
 * - Pure. The shell asks the Host and the fork store; this module decides what to ask for.
 * - `forkCommandRoute`: `/ask` with no argument or an on/off word is a setting of the Ask (`ask-setting`); `/ask` with
 *   a question opens the Ask (`ask-open`); every other command creates a fork.
 * - `forkKey` identifies one fork attempt by source, command and arguments, so a retry finds its reservation.
 * - `forkSettings` carries the session settings that were changed by the person: mutable, session-scoped and set.
 * - `forkCreateOptions`: a new session starts where the source stands (its directory, its model unless the provider
 *   is `dsh`, planning only if the source supports it and had it active). A remote `dsh` source stands in a
 *   registered workspace instead (`needsWorkspaceLookup`, `workspaceOptions`), and a source workspace that is no
 *   longer registered refuses the fork.
 * - `withForkContext`: a fork copies the conversation from the source's native session. (`/side` starts a temporary bot instead.)
 * - `forkedSession`: the new session is titled after the source and keeps the time its context was captured.
 * - `firstInputPending`: the text after the command is sent as the first input unless the fork already delivered it.
 */
import type { CreateSessionOptions } from '../../kernel/directory-client.js';
import { withMessageKey } from '@orchardworks/agent-client';

export type ForkCommandRoute = 'ask-setting' | 'ask-open' | 'fork';

export function forkCommandRoute(id: string, args: string): ForkCommandRoute {
  if (id !== 'console:ask') return 'fork';
  return ['', 'on', 'off', 'enable', 'disable'].includes(args.trim().toLowerCase()) ? 'ask-setting' : 'ask-open';
}

export function forkKey(sourceKey: string, id: string, args: string): string {
  return JSON.stringify([sourceKey, id, args]);
}

export function forkSettings<Setting extends { readonly id: string; readonly value: unknown; readonly mutable?: boolean; readonly scope?: string }>(
  settings: readonly Setting[],
): Pick<Setting, 'id' | 'value'>[] {
  return settings.filter(setting => setting.mutable && setting.scope === 'session' && setting.value !== null).map(({ id, value }) => ({ id, value }));
}

export interface ForkSourceAgent {
  readonly cwd?: string | null; readonly model?: string | null; readonly capabilities: { readonly planning?: boolean };
  readonly planningActive: boolean;
}

export function needsWorkspaceLookup(source: { readonly hostId?: string; readonly providerId: string }): boolean {
  return (source.hostId ?? 'local') !== 'local' && source.providerId === 'dsh';
}

export function workspaceOptions(cwd: string | null | undefined, workspaces: readonly { readonly id: string; readonly path: string }[]): CreateSessionOptions {
  const workspace = workspaces.find(({ path }) => path === cwd);
  if (cwd && !workspace) throw withMessageKey(new Error('The source workspace is no longer registered on this Host.'), 'client.fork.workspaceGone');
  return workspace ? { workspaceId: workspace.id } : {};
}

export function forkCreateOptions(agent: ForkSourceAgent, providerId: string): CreateSessionOptions {
  return { ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(agent.model && providerId !== 'dsh' ? { model: agent.model } : {}),
    ...(agent.capabilities.planning && providerId !== 'dsh' ? { planning: agent.planningActive } : {}) };
}

export function withForkContext(options: CreateSessionOptions, source: { readonly providerId: string; readonly nativeSessionId: string }): CreateSessionOptions {
  return { ...options, creationSource: { providerId: source.providerId, nativeSessionId: source.nativeSessionId } };
}

export function forkedSession(source: { readonly providerId: string; readonly hostId?: string; readonly title: string },
  result: { readonly agentId: string; readonly nativeSessionId?: string }, capturedAt: string) {
  return { agentId: result.agentId, nativeSessionId: result.nativeSessionId ?? result.agentId, providerId: source.providerId,
    hostId: source.hostId ?? 'local', title: `Fork of ${source.title}`, createdAt: capturedAt };
}

export function firstInputPending(args: string, delivery: string | undefined): boolean {
  return args.trim() !== '' && delivery !== 'sent';
}

