/**
 * Ask visibility: which sessions have an Ask, which of those the Workbench watches, when an Ask may open or restore,
 * and the reason a disabled Ask launcher gives.
 *
 * Contract
 * - Pure. The shell reads the succession document and the Ask store into plain facts and acts on what comes back.
 * - `askSourcesOf` lists, per Ask owner in document order, the session its source slot selects. An owner whose slot
 *   is missing or has no session is left out.
 * - `askActivityOf` lists the Asks that have a target conversation and are enabled. An Ask that is expanded but not
 *   attached yet is left out, since there is nothing to watch. Each entry says whether it is shown (the global Ask
 *   visibility boundary, shared with rendering) and which agent is live, when it is attached.
 * - `askRestoreAllowed` is whether a source may restore its Ask: with access, an Ask that already has a target restores
 *   unless the composition is protected; without a target, the source must be current, and under composition
 *   protection only an independent restore of a Side qualifies.
 * - `askUnavailableReason` explains a disabled Ask launcher, in this order: waiting for access, the session switch,
 *   the Controller offline; an Ask that already has a target is never unavailable; otherwise the staleness of its
 *   source, or "connecting" when the source has no agent state yet.
 */
import { translator, type MessageKey, type Translate } from '@orchardworks/agent-client';
import { resolveAskPresentation } from './ask-presentation.js';

export interface AskSourceOwner { readonly id: string; readonly sourceSlot: string }

export function askSourcesOf<Slot extends { readonly id: string }, Session>(
  slots: readonly Slot[], asks: readonly AskSourceOwner[], sessionOf: (slot: Slot) => Session | undefined,
): { owner: string; source: Session }[] {
  const byId = new Map(slots.map(slot => [slot.id, slot]));
  return asks.flatMap(owner => {
    const slot = byId.get(owner.sourceSlot), source = slot && sessionOf(slot);
    return source ? [{ owner: owner.id, source }] : [];
  });
}

export interface AskActivityFacts<Target> {
  readonly target: Target | undefined;
  readonly attached: boolean;
  readonly enabled: boolean;
  readonly expanded: boolean;
  readonly view: Parameters<typeof resolveAskPresentation>[0]['view'];
}

export function askActivityOf<Source, Target extends { readonly agentId: string }>(
  sources: readonly { owner: string; source: Source }[],
  read: (source: Source, owner: string) => AskActivityFacts<Target>,
  surface: { readonly window: Parameters<typeof resolveAskPresentation>[0]['window']; readonly visible: boolean; readonly compact: boolean },
): { session: Target; visible: boolean; liveAgentId: string | undefined }[] {
  return sources.flatMap(({ source, owner }) => {
    const facts = read(source, owner);
    if (!facts.enabled || !facts.target || facts.expanded && !facts.attached) return [];
    return [{ session: facts.target,
      visible: resolveAskPresentation({ window: surface.window, view: facts.view, visible: surface.visible, expanded: facts.expanded, compact: surface.compact }).shown,
      liveAgentId: facts.attached ? facts.target.agentId : undefined }];
  });
}

export function askRestoreAllowed(facts: { readonly accessReady: boolean; readonly hasTarget: boolean; readonly compositionProtected: boolean;
  readonly sourceAvailable: boolean; readonly independentRestore: boolean }): boolean {
  return facts.accessReady && (facts.hasTarget && !facts.compositionProtected
    || facts.sourceAvailable && (!facts.compositionProtected || facts.independentRestore));
}

export type AskSourceStaleness = 'inactive' | 'view' | 'connecting' | 'agent' | 'native';

const stalenessReason: Record<AskSourceStaleness | '', MessageKey | undefined> = {
  '': undefined,
  inactive: 'team.ask.unavailable.inactive',
  view: 'team.ask.unavailable.view',
  connecting: 'team.ask.unavailable.connecting',
  agent: 'team.ask.unavailable.agent',
  native: 'team.ask.unavailable.native',
};

export function askUnavailableReason(facts: { readonly hasSource: boolean; readonly accessReady: boolean; readonly hasDirectory: boolean;
  readonly transitioning: boolean; readonly controllerOffline: boolean; readonly hasTarget: boolean;
  readonly staleness: AskSourceStaleness | undefined; readonly hasAgentState: boolean }, t: Translate = translator('en')): string | undefined {
  if (!facts.hasSource) return undefined;
  if (!facts.hasDirectory || !facts.accessReady) return t('team.ask.unavailable.access');
  if (facts.transitioning) return t('team.ask.unavailable.switch');
  if (facts.controllerOffline) return t('team.ask.unavailable.offline');
  if (facts.hasTarget) return undefined;
  const reason = stalenessReason[facts.staleness ?? (facts.hasAgentState ? '' : 'connecting')];
  return reason && t(reason);
}
