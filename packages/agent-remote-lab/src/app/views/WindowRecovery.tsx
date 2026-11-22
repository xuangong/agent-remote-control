// The notice and Window list shown while the Window workspace is unavailable.
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { WindowWorkspaces } from '../../features/windows/WindowWorkspaces.js';
import type { AppScope } from '../types.js';

export function WindowRecovery({ scope }: { readonly scope: Pick<AppScope, 'closePage' | 'windowWorkspace'> }) {
  const t = useTranslate();
  const { closePage, windowWorkspace } = scope;
  return <>
    {windowWorkspace.unavailable ? <div className="lab-window-recovery" data-deleted={windowWorkspace.deleted || undefined}><p role="status">{windowWorkspace.deleted ? t('navigation.recovery.deleted') : windowWorkspace.error ?? t('navigation.recovery.opening')}</p><WindowWorkspaces workspace={windowWorkspace} onNavigate={closePage} /></div> : null}
  </>;
}
