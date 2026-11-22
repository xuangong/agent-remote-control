// What session references say about a session view: the /ref command, the reference list in the composer, and the page's own notes to the agent.
import type { ComponentProps } from 'react';
import type { Translate } from '@orchardworks/agent-client';
import type { LabWorkbenchActions } from '../../conversation/LabWorkbench.js';
import type { SessionViewContribution, SessionViewContext } from '../../conversation/session-view-contribution.js';
import { loadSessionRefs, sessionRefsEntry, type LabSessionRef } from '../../kernel/session-references.js';
import type { SessionFork } from '../../kernel/session-forks.js';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import type { OpenedSession } from '../../kernel/directory-client.js';
import { ForkReference } from './ForkReference.js';
import { refCommand, refCommandId, SessionReferences } from './SessionReferences.js';

export interface ReferenceContributionInputs {
  baseUrl: string;
  userScoped: boolean;
  directory: unknown;
  referencePicker: string | undefined;
  setReferencePicker(viewId: string | undefined): void;
  referencedActions(base: LabWorkbenchActions, session: OpenedSession, state: AgentReplicaState | undefined): LabWorkbenchActions;
  openExcerptSource(session: { hostId: string; providerId: string; nativeSessionId: string; title: string }): Promise<void> | void;
  removedReference(ref: LabSessionRef, restore: () => Promise<void>, fork: SessionFork | undefined): void | Promise<void>;
  restoredReference(fork: SessionFork | undefined): void | Promise<void>;
  revealSession(session: OpenedSession): void;
  unlinkSide: NonNullable<ComponentProps<typeof ForkReference>['onUnlink']>;
  reconcile(record: SessionFork): Promise<void>;
  t: Translate;
}

export const referenceContribution = (inputs: ReferenceContributionInputs) => (view: SessionViewContext): SessionViewContribution => {
  const { baseUrl, userScoped, directory, referencePicker, setReferencePicker, referencedActions, openExcerptSource, removedReference, restoredReference, revealSession, unlinkSide, reconcile, t } = inputs;
  const { context, botPresentation, source, host, available, fork, sourceForks } = view;
  // References live on the Host; a shared Host's sessions keep showing only their source.
  const referencing = userScoped && !!directory && host?.access !== 'shared' && !!host?.providers?.some(provider => provider.providerId === source.providerId && provider.sessionReferences);
  const holder = { hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId };
  // A Controller that tells the agent itself needs no note from this page.
  const pageNotes = referencing && !host?.providers?.some(provider => provider.providerId === source.providerId && provider.referenceNotes);
  const forkReference = fork ? <ForkReference fork={fork} onOpen={revealSession} onUnlink={unlinkSide} onRecover={record => reconcile(record)} /> : null;
  return {
    ...(pageNotes ? { wrapActions: (base: LabWorkbenchActions) => referencedActions(base, source, context.state) } : {}),
    consoleCommands: !botPresentation && referencing && available ? [refCommand(t)] : [],
    beforeSourceCheck: id => id !== refCommandId ? undefined : (async () => {
      await loadSessionRefs(baseUrl, holder);
      if (sessionRefsEntry(baseUrl, holder).unsupported) throw new Error(t('sessions.presentation.refsNeedUpdate'));
      setReferencePicker(source.viewId);
      return {};
    })(),
    composerContext: referencing ? <SessionReferences scope={baseUrl} holder={holder} providers={host?.providers?.map(provider => provider.providerId) ?? [source.providerId]}
      fallback={forkReference} snapshot={fork?.mode === 'reference' ? null : forkReference} picking={referencePicker === source.viewId}
      shown={new Set(sourceForks.flatMap(item => item.target ? [`${item.target.providerId}/${item.target.nativeSessionId}`] : []))} onPickingChange={picking => setReferencePicker(picking ? source.viewId : undefined)}
      onOpen={ref => void openExcerptSource({ hostId: source.hostId, providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, title: ref.title ?? '' })}
      onRemoved={(ref, restore) => removedReference(ref, restore, fork)} onRestore={() => restoredReference(fork)} /> : forkReference,
  };
};
