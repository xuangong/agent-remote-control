import { remoteSessionState, type RemoteSessionState } from '../client/session-state.js';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AgentSessionSetting, AgentSessionSettingChange } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '../replica/types.js';
import { AgentActionToolbar, type ComposerAction } from './AgentActionToolbar.js';
import { AgentSessionUsage } from './AgentSessionUsage.js';

export type SessionControlView = 'status' | 'model' | 'permissions' | 'actions';

interface Props {
  sessionState?: RemoteSessionState;
  state: AgentReplicaState;
  children?: ReactNode;
  actions?: readonly ComposerAction[];
  disabled: boolean;
  readOnly?: boolean;
  view?: SessionControlView;
  busy: boolean;
  onView(view?: SessionControlView): void;
  onPendingChange(pending: boolean): void;
  onSelect?(id: string, value: string): Promise<void>;
  renderError?(error: unknown): ReactNode;
}

export function AgentSessionSettings({ state, sessionState, children, actions = [], disabled, readOnly = false, view, busy, onView, onPendingChange, onSelect, renderError }: Props) {
  const id = useId();
  const layer = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement>();
  const restoreFocus = () => {
    const target = trigger.current?.isConnected ? trigger.current : layer.current?.querySelector<HTMLElement>('.agent-toolbar-more');
    target?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!view) return;
    const controls = layer.current;
    const keyboardScope = controls?.closest<HTMLElement>('.agent-composer') ?? controls;
    trigger.current = controls?.querySelector<HTMLElement>('.agent-session-toolbar [aria-expanded="true"]') ?? undefined;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !layer.current?.contains(event.target)) onView(undefined); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || layer.current?.closest('[hidden], [inert]')) return;
      const dialog = 'dialog, [role="dialog"], [role="alertdialog"]';
      if (!layer.current || !(event.target instanceof Element) || event.target.closest(dialog) !== layer.current.closest(dialog)) return;
      event.preventDefault();
      onView(undefined);
      restoreFocus();
    };
    document.addEventListener('pointerdown', dismiss);
    keyboardScope?.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); keyboardScope?.removeEventListener('keydown', escape); };
  }, [view, onView]);
  const agent = state.agent!;
  const settings = agent.runtimeInfo.settings ?? [];
  const changes = agent.settingChanges ?? [];
  const changeFor = (setting: AgentSessionSetting) => changes.find(change => change.settingId === setting.id);
  const shownSettings = settings.map(setting => ({ ...setting, value: displayedValue(setting, changeFor(setting)) }));
  const [readOutcomes, setReadOutcomes] = useState<Record<string, string>>({});
  const outcomeScope = (change: AgentSessionSettingChange) => `${agent.id}:${change.settingId}`;
  const outcomeKey = (change: AgentSessionSettingChange) => `${change.requestId}:${change.status}`;
  useEffect(() => {
    if (view !== 'model' && view !== 'permissions') return;
    const outcomes = changes.filter(change => change.status !== 'pending' && change.category === view);
    if (!outcomes.length) return;
    setReadOutcomes(previous => {
      if (outcomes.every(change => previous[outcomeScope(change)] === outcomeKey(change))) return previous;
      return { ...previous, ...Object.fromEntries(outcomes.map(change => [outcomeScope(change), outcomeKey(change)])) };
    });
  }, [agent.id, agent.settingChanges, agent.runtimeInfo.settings, view]);
  const categoryPending = (category: string) => changes.some(change => change.status === 'pending' && change.category === category);
  const categoryUnread = (category: string) => view !== category && changes.some(change => change.status !== 'pending' && readOutcomes[outcomeScope(change)] !== outcomeKey(change) && change.category === category);
  const categoryLabel = (category: 'model' | 'permissions') => `${category === 'model' ? 'Model' : 'Permissions'}${categoryPending(category) ? ', change pending' : ''}${categoryUnread(category) ? ', unread setting error' : ''}`;
  const session = sessionState ?? remoteSessionState(state, disabled ? 'connecting' : 'ready');
  const disconnected = disabled || !session.synchronized;
  const runtimeConnection = session.runtime;
  const runtimeConnected = runtimeConnection === undefined || runtimeConnection.state === 'connected';
  const runtimeUnavailable = settingsRecoveryMessage(runtimeConnection?.state);
  const [failure, setFailure] = useState<{ error: unknown; message: string }>();
  const inFlight = useRef(false);
  const canChange = !disabled && !readOnly && !busy && onSelect !== undefined && session.operations.set_session_setting.allowed;

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
  const model = shownSettings.find(({ id }) => id === 'model');
  const permissions = shownSettings.filter(({ category }) => category === 'permissions');
  const modelLabel = model ? selectedLabel(model) : agent.runtimeInfo.model;
  const permissionLabel = permissions.map(selectedLabel).filter((label) => label !== 'Unavailable').join(' · ');
  return <div className="agent-session-controls" ref={layer}>
    <AgentActionToolbar active={view} overflowOpen={view === 'actions'} onOverflow={open => onView(open ? 'actions' : undefined)} onStatus={() => onView(view === 'status' ? undefined : 'status')}
      actions={[...actions,
        { id: 'model', label: categoryLabel('model'), testId: 'session-model-button', priority: 100,
          title: `Model: ${modelLabel ?? 'Unavailable'}`, expanded: view === 'model',
          content: <><span className={categoryPending('model') ? 'agent-setting-pending' : undefined}>{modelLabel && modelLabel !== 'Unavailable' ? modelLabel : 'Model'}</span><span aria-hidden="true"> ▾</span></>, run: () => onView(view === 'model' ? undefined : 'model') },
        { id: 'permissions', label: categoryLabel('permissions'), testId: 'session-permissions-button', priority: 10,
          title: `Permissions: ${permissions.length ? permissions.map(selectedLabel).join(' · ') : 'Unavailable'}`, expanded: view === 'permissions',
          content: <><span className={categoryPending('permissions') ? 'agent-setting-pending' : undefined}>{permissionLabel || 'Permissions'}</span><span aria-hidden="true"> ▾</span></>, run: () => onView(view === 'permissions' ? undefined : 'permissions') },
      ]} />
    <section hidden={!view || view === 'actions'} className="agent-session-panel" aria-label={view === 'status' ? 'Session status' : `${view === 'model' ? 'Model' : 'Permission'} settings`}>
      <div className="agent-session-panel-heading"><strong>{view === 'status' ? 'Session status' : view === 'model' ? 'Model settings' : 'Permission settings'}</strong><button type="button" aria-label="Close session controls" onClick={() => { onView(undefined); restoreFocus(); }}>Close</button></div>
      {recovery}
      <div hidden={view !== 'status'}>{children}</div>
      {view === 'status' ? <><dl className="agent-session-facts">
          <dt>Provider</dt><dd>{agent.providerId}</dd><dt>Session</dt><dd>{agent.runtimeInfo.sessionId ?? 'Unavailable'}</dd>
          <dt>Connection</dt><dd>{disconnected ? 'Unavailable' : connectionLabel(runtimeConnection?.state)}</dd><dt>Runtime</dt><dd>{session.activity}{disconnected || !runtimeConnected ? ' (last known)' : ''}</dd>
          <dt>Directory</dt><dd>{agent.runtimeInfo.cwd ?? 'Unavailable'}</dd>
          {settings.map((setting) => <div key={setting.id}><dt>{setting.label}</dt><dd>{selectedLabel({ ...setting, value: setting.value ?? changeFor(setting)?.confirmedValue ?? null })}</dd></div>)}
        </dl><AgentSessionUsage usage={agent.lastUsage} lastKnown={disconnected || !runtimeConnected} /></>
        : <>
          {shownSettings.filter(({ category }) => category === view).map((setting) => {
            const settingChange = changeFor(setting);
            const pending = settingChange?.status === 'pending';
            const noteId = `${id}-${setting.id}-change`;
            const original = settings.find(original => original.id === setting.id)!;
            const actual = selectedLabel({ ...original, value: original.value ?? settingChange?.confirmedValue ?? null });
            const message = settingChange?.message ?? (settingChange?.status === 'timed_out' ? 'Change was not confirmed in time.' : 'Change could not be applied.');
            const publicRecovery = settingChange && !pending && settingChange.code === 'reauthentication_required'
              ? renderError?.(Object.assign(new Error(message), { code: settingChange.code })) : undefined;
            return <div className="agent-session-setting" key={setting.id} data-setting-state={pending ? 'pending' : undefined}>
              <label htmlFor={`${id}-${setting.id}`}>{setting.label}</label>
              <select id={`${id}-${setting.id}`} aria-label={setting.label} aria-describedby={settingChange ? noteId : undefined} data-testid={`session-setting-${setting.id}`} value={setting.value ?? ''}
                disabled={!canChange || !setting.mutable} onChange={(event) => void change(setting, event.target.value)}>
                {!setting.options.some(({ value }) => value === setting.value) ? <option value={setting.value ?? ''}>{setting.value ?? 'Unavailable'}</option> : null}
                {setting.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {settingChange ? <div id={noteId} className={`agent-composer-note${pending ? ' agent-setting-pending' : ''}`}>
                {pending ? `Pending. Current: ${actual}.` : publicRecovery ?? message}
              </div> : null}
              {setting.description ? <span className="agent-composer-note">{setting.description}</span> : null}
              {setting.options.find(({ value }) => value === setting.value)?.description ? <span className="agent-composer-note">{setting.options.find(({ value }) => value === setting.value)?.description}</span> : null}
              {setting.scope === 'session_and_default' ? <span className="agent-setting-scope">Also changes the default for future sessions.</span> : null}
            </div>;
          })}
          {changes.filter(change => change.category === view && !settings.some(setting => setting.id === change.settingId)).map(change => {
            const pending = change.status === 'pending';
            const message = change.message ?? (change.status === 'timed_out' ? 'Change was not confirmed in time.' : 'Change could not be applied.');
            const publicRecovery = !pending && change.code === 'reauthentication_required'
              ? renderError?.(Object.assign(new Error(message), { code: change.code })) : undefined;
            return <div className="agent-session-setting" key={change.settingId} data-setting-state={pending ? 'pending' : undefined}>
              <span>{change.label}</span>
              {pending ? <span className="agent-setting-pending">{change.targetValue}</span> : null}
              <div className={`agent-composer-note${pending ? ' agent-setting-pending' : ''}`}>
                {pending ? `Pending. Current: ${change.confirmedValue ?? 'Unavailable'}.` : publicRecovery ?? message}
              </div>
            </div>;
          })}
          {settings.some(({ category }) => category === view) ? <p className="agent-composer-note" role="status">{readOnly ? 'Read only. Take control to change session settings.' : busy ? 'Submitting change.' : runtimeUnavailable ?? (disconnected ? 'Disconnected. Values are last known; reconnect to change settings.' : !canChange ? 'Session settings are temporarily unavailable.' : 'Changes apply when confirmed by the Provider.')}</p>
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

function displayedValue(setting: AgentSessionSetting, change?: AgentSessionSettingChange): string | null {
  return change?.status === 'pending' ? change.targetValue : setting.value ?? change?.confirmedValue ?? null;
}
