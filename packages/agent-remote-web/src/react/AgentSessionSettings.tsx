import { useRef, useState } from 'react';
import type { AgentSessionSetting } from '@borgee/agent-remote-protocol';
import type { AgentReplicaState } from '../replica/types.js';

export type SessionControlView = 'status' | 'model' | 'permissions';

interface Props {
  state: AgentReplicaState;
  disabled: boolean;
  view?: SessionControlView;
  busy: boolean;
  onView(view?: SessionControlView): void;
  onPendingChange(pending: boolean): void;
  onSelect?(id: string, value: string): Promise<void>;
}

export function AgentSessionSettings({ state, disabled, view, busy, onView, onPendingChange, onSelect }: Props) {
  const agent = state.agent!;
  const settings = agent.runtimeInfo.settings ?? [];
  const [failure, setFailure] = useState<string>();
  const inFlight = useRef(false);
  const canChange = !disabled && !busy && agent.status === 'idle' && !agent.activeTurn
    && state.pendingInteractions.length === 0 && agent.capabilities.sessionSettings === true && onSelect !== undefined;

  async function change(setting: AgentSessionSetting, value: string): Promise<void> {
    if (!canChange || inFlight.current || !setting.mutable || !setting.options.some((option) => option.value === value) || !onSelect) return;
    if (value === setting.value) return;
    inFlight.current = true;
    setFailure(undefined);
    onPendingChange(true);
    try { await onSelect(setting.id, value); }
    catch (error) {
      setFailure(error instanceof Error ? error.message : 'Session setting could not be changed.');
    } finally {
      inFlight.current = false;
      onPendingChange(false);
    }
  }

  const model = settings.find(({ id }) => id === 'model');
  const permissions = settings.filter(({ category }) => category === 'permissions');
  return <div className="agent-session-controls">
    <div className="agent-session-toolbar" aria-label="Session controls">
      <button type="button" data-testid="session-model-button" aria-expanded={view === 'model'} onClick={() => onView(view === 'model' ? undefined : 'model')}>Model: {model ? selectedLabel(model) : agent.runtimeInfo.model ?? 'Unavailable'}</button>
      <button type="button" data-testid="session-permissions-button" aria-expanded={view === 'permissions'} onClick={() => onView(view === 'permissions' ? undefined : 'permissions')}>Permissions: {permissions.length ? permissions.map(selectedLabel).join(' · ') : 'Unavailable'}</button>
      <button type="button" aria-expanded={view === 'status'} onClick={() => onView(view === 'status' ? undefined : 'status')}>Status</button>
    </div>
    {view ? <section className="agent-session-panel" aria-label={view === 'status' ? 'Session status' : `${view === 'model' ? 'Model' : 'Permission'} settings`}>
      <div className="agent-session-panel-heading"><strong>{view === 'status' ? 'Session status' : view === 'model' ? 'Model settings' : 'Permission settings'}</strong><button type="button" aria-label="Close session controls" onClick={() => onView(undefined)}>Close</button></div>
      {view === 'status' ? <dl className="agent-session-facts">
          <dt>Provider</dt><dd>{agent.providerId}</dd><dt>Session</dt><dd>{agent.runtimeInfo.sessionId ?? 'Unavailable'}</dd>
          <dt>Connection</dt><dd>{disabled ? 'Unavailable' : 'Connected'}</dd><dt>Runtime</dt><dd>{agent.status}{disabled ? ' (last known)' : ''}</dd>
          <dt>Directory</dt><dd>{agent.runtimeInfo.cwd ?? 'Unavailable'}</dd>
          {settings.map((setting) => <div key={setting.id}><dt>{setting.label}</dt><dd>{selectedLabel(setting)}</dd></div>)}
        </dl>
        : <>
          {settings.filter(({ category }) => category === view).map((setting) => <label className="agent-session-setting" key={setting.id}>
            <span>{setting.label}</span>
            <select aria-label={setting.label} data-testid={`session-setting-${setting.id}`} value={setting.value ?? ''}
              disabled={!canChange || !setting.mutable} onChange={(event) => void change(setting, event.target.value)}>
              {!setting.options.some(({ value }) => value === setting.value) ? <option value={setting.value ?? ''}>{setting.value ?? 'Unavailable'}</option> : null}
              {setting.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {setting.description ? <span className="agent-composer-note">{setting.description}</span> : null}
            {setting.options.find(({ value }) => value === setting.value)?.description ? <span className="agent-composer-note">{setting.options.find(({ value }) => value === setting.value)?.description}</span> : null}
            {setting.scope === 'session_and_default' ? <span className="agent-setting-scope">Also changes the default for future sessions.</span> : null}
          </label>)}
          {settings.some(({ category }) => category === view) ? <p className="agent-composer-note" role="status">{busy ? 'Waiting for Provider confirmation.' : disabled ? 'Disconnected. Values are last known; reconnect to change settings.' : !canChange ? 'Settings can change only while idle with no pending interactions.' : 'Changes apply to subsequent turns.'}</p>
            : <p className="agent-composer-note">This Provider does not expose these session settings.</p>}
        </>}
      {failure ? <p role="alert" className="agent-composer-note">{failure}</p> : null}
    </section> : null}
  </div>;
}

function selectedLabel(setting: AgentSessionSetting): string {
  return setting.options.find(({ value }) => value === setting.value)?.label ?? setting.value ?? 'Unavailable';
}
