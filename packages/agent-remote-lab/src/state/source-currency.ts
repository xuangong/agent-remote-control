/**
 * Source currency: whether the session an Ask, Side or quote was captured from is still what its view shows.
 *
 * Contract
 * - Pure. The shell reads the group's binding for the source's view and the fixture agent, and passes them in.
 * - A view is stale (`view`) when its group binding cannot be resolved, belongs to another group or view than the one
 *   captured, or names another session than the source.
 * - A fixture Workbench without succession (a state shown from a fixture) is judged from its one agent: no matching
 *   slot is `view`, no agent yet is `connecting`, another agent is `agent`, another native session is `native`.
 * - Anything else is the succession model's decision (`succession.sourceStale`).
 */
import type { SourceStaleness } from '@orchardworks/agent-client';

export type GroupBindingLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'unresolvable' }
  | { readonly kind: 'bound'; readonly groupId: string; readonly viewId: string; readonly sessionKey: string };

export interface CapturedBot { readonly groupId: string; readonly viewId: string }

export function viewStaleness(input: { readonly captured: CapturedBot | undefined; readonly lookup: GroupBindingLookup; readonly sourceKey: string }): 'view' | undefined {
  const { captured, lookup, sourceKey } = input;
  if (lookup.kind === 'unresolvable') return 'view';
  const mapped = lookup.kind === 'bound' ? lookup : undefined;
  if (captured && (!mapped || mapped.groupId !== captured.groupId || mapped.viewId !== captured.viewId)) return 'view';
  if (mapped && mapped.sessionKey !== sourceKey) return 'view';
  return undefined;
}

export interface FixtureSource { readonly agentId?: string; readonly providerId: string; readonly nativeSessionId: string }

export function fixtureStaleness(input: {
  /** The session key of the slot the source's view selects, or undefined when no slot has that view. */
  readonly slotSelectionKey: string | undefined;
  readonly sourceKey: string;
  readonly agent: { readonly id: string; readonly providerId: string; readonly nativeSessionId: string | null | undefined } | null | undefined;
  readonly source: FixtureSource;
}): SourceStaleness | undefined {
  const { agent, source } = input;
  if (input.slotSelectionKey === undefined || input.slotSelectionKey !== input.sourceKey) return 'view';
  if (!agent) return 'connecting';
  if (agent.id !== source.agentId) return 'agent';
  return agent.providerId === source.providerId && agent.nativeSessionId === source.nativeSessionId ? undefined : 'native';
}
