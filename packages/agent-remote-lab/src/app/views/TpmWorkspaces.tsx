// The TPM workspaces.
import { tpmMainTarget } from '../../kernel/tpm-main-sessions.js';
import { TpmWorkspace } from '../../features/team/TpmWorkspace.js';
import { sessionKey } from '../../kernel/session-tree.js';
import type { AppScope } from '../types.js';

export function TpmWorkspaces({ scope }: { readonly scope: Pick<AppScope, 'baseUrl' | 'compactLayout' | 'messageDrafts' | 'openTpmMain' | 'presentedFeature' | 'replicaFor' | 'sessionWindows' | 'setTpmListOpen' | 'sharedWindow' | 'supportingRailOpen' | 'tpm' | 'tpmMainSessions' | 'tpmTriggerRef' | 'tpmView' | 'transport' | 'viewNavigation' | 'windowMode'> }) {
  const { baseUrl, compactLayout, messageDrafts, openTpmMain, presentedFeature, replicaFor, sessionWindows, setTpmListOpen, sharedWindow, supportingRailOpen, tpm, tpmMainSessions, tpmTriggerRef, tpmView, transport, viewNavigation, windowMode } = scope;
  return <>
    <div className="lab-tpm-workspaces">{tpm.opened.map((key, index) => {
      const item = tpm.works.find(item => item.key === key);
      if (!item) return null;
      return <TpmWorkspace key={key} item={item} mainTitle={tpmMainSessions.get(sessionKey(tpmMainTarget(item)))?.title} session={tpm.sessions[key]} replica={tpm.sessions[key] ? replicaFor(tpm.sessions[key]!.agentId) : undefined}
        visible={windowMode && tpmView.visible && tpm.windows.includes(key) && (!compactLayout || (sharedWindow ? presentedFeature?.kind === 'tpm' && presentedFeature.id === key : tpm.selected === key)) && !supportingRailOpen}
        layer={tpm.windows.indexOf(key) + 1} initialOffset={(index % 6) * 28} onFocus={() => { if (!sharedWindow) sessionWindows.focus(); tpm.focus(key); }} storageScope={baseUrl} triggerRef={tpmTriggerRef}
        transport={transport} draftBinding={{ store: messageDrafts, key: `tpm:${key}` }} navigation={viewNavigation}
        busy={!!tpm.busy} attaching={tpm.attaching[key] || tpm.detailsLoading[key]} error={tpm.detailErrors[key] ?? tpm.attachmentErrors[key]}
        onClose={() => tpm.close(key)} onShowList={() => setTpmListOpen(true)}
        onOpenMain={() => void openTpmMain(item)}
        onRename={title => tpm.rename(key, title)} onAction={action => tpm.action(key, action)} onConfirmTodo={decision => tpm.confirmTodo(key, decision)} onResolve={(id, resolution, nativeSessionId) => tpm.resolve(key, id, resolution, nativeSessionId)} onRetry={() => void tpm.open(key)} />;
    })}</div>
  </>;
}
