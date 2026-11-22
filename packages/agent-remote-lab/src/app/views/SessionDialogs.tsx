// The Recover Handoff button and the rename dialog.
import { RenameSessionDialog } from '../../features/sessions/favorites/RenameSessionDialog.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function SessionDialogs({ scope }: { readonly scope: Pick<AppScope, 'activeView' | 'applySessionTitle' | 'baseUrl' | 'favorites' | 'primaryExpanded' | 'renamingSession' | 'revealSession' | 'setDirectoryRevision' | 'setRenamingSession' | 'setSuccessionDialog' | 'showView' | 'stackRoot' | 'successionDialog'> }) {
  const { activeView, applySessionTitle, baseUrl, favorites, primaryExpanded, renamingSession, revealSession, setDirectoryRevision, setRenamingSession, setSuccessionDialog, showView, stackRoot, successionDialog } = scope;
  const t = useTranslate();
  return <>
    {successionDialog && (activeView !== 'workbench' || !primaryExpanded) ? <button type="button" onClick={() => {
      showView('workbench'); if (stackRoot) revealSession(stackRoot);
      setSuccessionDialog(current => current ? { ...current, visible: true } : current);
    }}>{t('windows.recoverHandoff')}</button> : null}
    {renamingSession?.scope === baseUrl ? <RenameSessionDialog favorites={favorites} session={renamingSession.session}
      onRenamed={session => { applySessionTitle(session); setDirectoryRevision(value => value + 1); }} onClose={() => setRenamingSession(undefined)} /> : null}
  </>;
}
