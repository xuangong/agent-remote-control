import { errorWords } from '@orchardworks/agent-client';
import { useEffect, useId, useRef, useState } from 'react';
import type { SessionDirectoryClient, SessionWorkspace } from '../directory-client.js';
import { useFeedbackToast } from './Toast.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { WorkspaceFolderPicker } from './WorkspaceFolderPicker.js';

export interface WorkspaceSelection { workspaceId?: string; path?: string }
interface Scope { directory: SessionDirectoryClient; providerId: string }
interface WorkspaceCatalog extends Scope { workspaces: SessionWorkspace[]; loading: boolean; failure?: string }

/** A selection carries the Host's path, including for a registered workspace. */
export function WorkspaceSelect({ directory, providerId, disabled, value, onChange, canBrowse = true, required = false }: {
  directory: SessionDirectoryClient; providerId: string; disabled: boolean; value: WorkspaceSelection;
  onChange(value: WorkspaceSelection): void; canBrowse?: boolean; required?: boolean;
}) {
  const t = useTranslate();
  const id = useId();
  const [browsing, setBrowsing] = useState<Scope>();
  const [catalog, setCatalog] = useState<WorkspaceCatalog>();
  const [retry, setRetry] = useState(0);
  const browseButton = useRef<HTMLButtonElement>(null);
  const current = catalog?.directory === directory && catalog.providerId === providerId ? catalog : undefined;
  const workspaces = current?.workspaces ?? [], loading = current?.loading ?? !!providerId, failure = current?.failure;
  useFeedbackToast(t('sessions.workspace.listTitle'), failure);
  useEffect(() => {
    let retired = false;
    setBrowsing(undefined);
    setCatalog({ directory, providerId, workspaces: [], loading: !!providerId });
    if (!providerId) return;
    void directory.workspaces(providerId).then(result => {
      if (!retired) setCatalog({ directory, providerId, workspaces: result.workspaces, loading: false });
    }).catch(error => {
      if (!retired) setCatalog({ directory, providerId, workspaces: [], loading: false,
        failure: errorWords(error, t, 'sessions.workspace.loadFailed') });
    });
    return () => { retired = true; };
  }, [directory, providerId, retry]);
  return <div className="lab-workspace-selection">
    <label htmlFor={id}>{t('sessions.workspace.label')}</label>
    <div className="lab-workspace-field">
      <select id={id} required={required} value={value.workspaceId ?? (value.path ? '__custom_folder' : '')}
        disabled={disabled || loading || !providerId} onChange={event => {
          const workspace = workspaces.find(item => item.id === event.target.value);
          onChange(workspace ? { workspaceId: workspace.id, path: workspace.path } : {});
        }}>
        <option value="">{required ? t('sessions.workspace.choose') : t('sessions.workspace.hostDefault')}</option>
        {!value.workspaceId && value.path ? <option value="__custom_folder">{value.path}</option> : null}
        {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.path}</option>)}
      </select>
      {canBrowse && providerId !== 'dsh' ? <button ref={browseButton} type="button" disabled={disabled || loading || !providerId} onClick={() => setBrowsing({ directory, providerId })}>{t('sessions.workspace.browse')}</button> : null}
    </div>
    {browsing?.directory === directory && browsing.providerId === providerId && canBrowse && !disabled
      ? <WorkspaceFolderPicker directory={directory} providerId={providerId} workspaces={workspaces} opener={browseButton}
          initialPath={value.path ?? workspaces.find(workspace => workspace.id === value.workspaceId)?.path}
          onClose={() => setBrowsing(undefined)} onSelect={path => { onChange({ path }); setBrowsing(undefined); }} /> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure} <button type="button" disabled={disabled} onClick={() => setRetry(value => value + 1)}>{t('sessions.workspace.retry')}</button></p> : null}
  </div>;
}
