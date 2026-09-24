import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentSessionSetting } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '../replica/types.js';

export type SessionControlView = 'status' | 'model' | 'permissions';

interface Props {
  state: AgentReplicaState;
  children?: ReactNode;
  disabled: boolean;
  readOnly?: boolean;
  view?: SessionControlView;
  busy: boolean;
  onView(view?: SessionControlView): void;
  onPendingChange(pending: boolean): void;
  onSelect?(id: string, value: string): Promise<void>;
  renderError?(error: unknown): ReactNode;
}

export function AgentSessionSettings({ state, children, disabled, readOnly = false, view, busy, onView, onPendingChange, onSelect, renderError }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement>();
  useEffect(() => {
    if (!view) return;
    trigger.current = layer.current?.querySelector<HTMLElement>('[aria-expanded="true"]') ?? undefined;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !layer.current?.contains(event.target)) onView(undefined); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || layer.current?.closest('[hidden], [inert]')) return;
      event.preventDefault();
      onView(undefined);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [view, onView]);
  const agent = state.agent!;
  const settings = agent.runtimeInfo.settings ?? [];
  const runtimeConnection = agent.runtimeInfo.connection;
  const runtimeConnected = runtimeConnection === undefined || runtimeConnection.state === 'connected';
  const runtimeUnavailable = settingsRecoveryMessage(runtimeConnection?.state);
  const [failure, setFailure] = useState<{ error: unknown; message: string }>();
  const inFlight = useRef(false);
  const canChange = !readOnly && !disabled && runtimeConnected && !busy && agent.status === 'idle' && !agent.activeTurn
    && state.pendingInteractions.length === 0 && agent.capabilities.sessionSettings === true && onSelect !== undefined;

  async function change(setting: AgentSessionSetting, value: string): Promise<void> {
    if (!canChange || inFlight.current || !setting.mutable || !setting.options.some((option) => option.value === value) || !onSelect) return;
    if (value === setting.value) return;
    inFlight.current = true;
    setFailure(undefined);
    onPendingChange(true);
    try { await onSelect(setting.id, value); }
    catch (error) {
      setFailure({ error, message: error instanceof Error ? error.message : 'Session setting could not be changed.' });
    } finally {
      inFlight.current = false;
      onPendingChange(false);
    }
  }

  const recovery = failure ? renderError?.(failure.error) : undefined;
  const model = settings.find(({ id }) => id === 'model');
  const permissions = settings.filter(({ category }) => category === 'permissions');
  const modelLabel = model ? selectedLabel(model) : agent.runtimeInfo.model;
  const permissionLabel = permissions.map(selectedLabel).filter((label) => label !== 'Unavailable').join(' · ');
  return <div className="agent-session-controls" ref={layer}>
    <div className="agent-session-toolbar" aria-label="Session controls">
      <button type="button" data-testid="session-model-button" title={`Model: ${modelLabel ?? 'Unavailable'}`} aria-expanded={view === 'model'} onClick={() => onView(view === 'model' ? undefined : 'model')}>{modelLabel && modelLabel !== 'Unavailable' ? modelLabel : 'Model'}<span aria-hidden="true"> ▾</span></button>
      <button type="button" data-testid="session-permissions-button" title={`Permissions: ${permissions.length ? permissions.map(selectedLabel).join(' · ') : 'Unavailable'}`} aria-expanded={view === 'permissions'} onClick={() => onView(view === 'permissions' ? undefined : 'permissions')}>{permissionLabel || 'Permissions'}<span aria-hidden="true"> ▾</span></button>
      <button type="button" aria-expanded={view === 'status'} onClick={() => onView(view === 'status' ? undefined : 'status')} aria-label="Status" title="Session status and planning"><span aria-hidden="true">•••</span></button>
    </div>
    <section hidden={!view} className="agent-session-panel" aria-label={view === 'status' ? 'Session status' : `${view === 'model' ? 'Model' : 'Permission'} settings`}>
      <div className="agent-session-panel-heading"><strong>{view === 'status' ? 'Session status' : view === 'model' ? 'Model settings' : 'Permission settings'}</strong><button type="button" aria-label="Close session controls" onClick={() => { onView(undefined); trigger.current?.focus({ preventScroll: true }); }}>Close</button></div>
      {recovery}
      <div hidden={view !== 'status'}>{children}</div>
      {view === 'status' ? <dl className="agent-session-facts">
          <dt>Provider</dt><dd>{agent.providerId}</dd><dt>Session</dt><dd>{agent.runtimeInfo.sessionId ?? 'Unavailable'}</dd>
          <dt>Connection</dt><dd>{disabled ? 'Unavailable' : connectionLabel(runtimeConnection?.state)}</dd><dt>Runtime</dt><dd>{agent.status}{disabled || !runtimeConnected ? ' (last known)' : ''}</dd>
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
          {settings.some(({ category }) => category === view) ? <p className="agent-composer-note" role="status">{readOnly ? 'Read only. Take control to change session settings.' : busy ? 'Waiting for Provider confirmation.' : runtimeUnavailable ?? (disabled ? 'Disconnected. Values are last known; reconnect to change settings.' : !canChange ? 'Settings can change only while idle with no pending interactions.' : 'Changes apply to subsequent turns.')}</p>
            : <p className="agent-composer-note">This Provider does not expose these session settings.</p>}
        </>}
      {failure && !recovery ? <p role="alert" className="agent-composer-note">{failure.message}</p> : null}
    </section>
  </div>;
}

function connectionLabel(state?: 'connected' | 'reconnecting' | 'restoring' | 'unavailable'): string {
  if (state === 'reconnecting') return 'Reconnecting';
  if (state === 'restoring') return 'Restoring';
  if (state === 'unavailable') return 'Unavailable';
  return 'Connected';
}

function settingsRecoveryMessage(state?: 'connected' | 'reconnecting' | 'restoring' | 'unavailable'): string | undefined {
  if (state === 'reconnecting') return 'Native runtime is reconnecting. Values are last known; changes are temporarily unavailable.';
  if (state === 'restoring') return 'Native runtime is restoring this session. Values are last known; changes are temporarily unavailable.';
  if (state === 'unavailable') return 'Native runtime is unavailable. Values are last known; changes are unavailable.';
  return undefined;
}

function selectedLabel(setting: AgentSessionSetting): string {
  return setting.options.find(({ value }) => value === setting.value)?.label ?? setting.value ?? 'Unavailable';
}
