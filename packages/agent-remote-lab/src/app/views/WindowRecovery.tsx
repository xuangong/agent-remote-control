// The notice and Window list shown while the Window workspace is unavailable.
import { WindowWorkspaces } from '../../components/WindowWorkspaces.js';
import type { AppScope } from '../types.js';

export function WindowRecovery({ scope }: { readonly scope: Pick<AppScope, 'closePage' | 'windowWorkspace'> }) {
  const { closePage, windowWorkspace } = scope;
  return <>
    {windowWorkspace.unavailable ? <div className="lab-window-recovery" data-deleted={windowWorkspace.deleted || undefined}><p role="status">{windowWorkspace.deleted ? 'Window deleted. Choose another Window or create a new one.' : windowWorkspace.error ?? 'Opening Window…'}</p><WindowWorkspaces workspace={windowWorkspace} onNavigate={closePage} /></div> : null}
  </>;
}
