import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AgentSessionSetting, AgentSessionSettingChange } from '@orchardworks/agent-remote-protocol';
import { ComposerMenu, ComposerMenuItems, type ComposerMenuEntry } from './ComposerMenu.js';
import type { ComposerMenuItem } from './composer-menu.js';
import { AgentSessionUsage } from './AgentSessionUsage.js';
import { useTranslate } from './locale.js';
import { errorWords, remoteSessionState, sessionActivityLabel, type RemoteSessionState, type AgentReplicaState, type Translate } from '@orchardworks/agent-client';

export type SessionControlView = 'status' | 'model' | 'permissions' | 'actions';

/** The settings' items when the host does not pass `composerMenu`'s: all three, enabled. */
const SETTINGS_ITEMS: readonly ComposerMenuItem[] = [{ id: 'model', enabled: true }, { id: 'permissions', enabled: true }, { id: 'status', enabled: true }];

interface Props {
  sessionState?: RemoteSessionState;
  state: AgentReplicaState;
  children?: ReactNode;
  /** The composer's own entries of the + menu (Image, Resource, Command, Queue); the settings' entries follow them. */
  entries?: readonly ComposerMenuEntry[];
  /** The settings' items as `composerMenu` gives them (Model, Permissions, Status). */
  items?: readonly ComposerMenuItem[];
  /** Where the settings stand: behind the composer's + (`menu`), or open as rows where nothing else holds them (`list`, the details). */
  presentation?: 'menu' | 'list';
  disabled: boolean;
  readOnly?: boolean;
  view?: SessionControlView;
  busy: boolean;
  onView(view?: SessionControlView): void;
  onPendingChange(pending: boolean): void;
  onSelect?(id: string, value: string): Promise<void>;
  renderError?(error: unknown): ReactNode;
}

/**
 * The session's settings where the composer shows them (`settings="inline"`): their entries in the composer's + menu, and the panel
 * an entry opens above the capsule (Model, Permissions, Status with planning and usage).
 */
export function AgentSessionSettings({ state, sessionState, children, entries = [], items = SETTINGS_ITEMS, presentation = 'menu', disabled, readOnly = false, view, busy, onView, onPendingChange, onSelect, renderError }: Props) {
  const t = useTranslate();
  const id = useId();
  const layer = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement>();
  const restoreFocus = () => {
    const target = trigger.current?.isConnected ? trigger.current : layer.current?.querySelector<HTMLElement>('.agent-composer-plus');
    target?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!view || view === 'actions') return;
    const controls = layer.current;
    const keyboardScope = controls?.closest<HTMLElement>('.agent-composer') ?? controls;
    // Focus returns to "+" in the composer, or to the row that opened the panel where the settings stand open.
    trigger.current = controls?.querySelector<HTMLElement>(`.agent-composer-plus, [data-action-id="${view}"]`) ?? undefined;
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
  const categoryLabel = (category: 'model' | 'permissions') => `${t(category === 'model' ? 'composer.model' : 'composer.permissions')}${categoryPending(category) ? t('composer.changePending') : ''}${categoryUnread(category) ? t('composer.unreadError') : ''}`;
  const session = sessionState ?? remoteSessionState(state, disabled ? 'connecting' : 'ready');
  const disconnected = disabled || !session.synchronized;
  const runtimeConnection = session.runtime;
  const runtimeConnected = runtimeConnection === undefined || runtimeConnection.state === 'connected';
  const runtimeUnavailable = settingsRecoveryMessage(runtimeConnection?.state, t);
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
      setFailure({ error, message: errorWords(error, t, 'composer.settings.changeFailed') });
    } finally {
      inFlight.current = false;
      onPendingChange(false);
    }
  }

  const recovery = failure ? renderError?.(failure.error) : undefined;
  const model = shownSettings.find(({ id }) => id === 'model');
  const permissions = shownSettings.filter(({ category }) => category === 'permissions');
  const unavailable = t('common.unavailable');
  const modelLabel = model ? selectedLabel(model, unavailable) : agent.runtimeInfo.model;
  const permissionLabel = permissions.map(setting => selectedLabel(setting, unavailable)).filter((label) => label !== unavailable).join(' · ');
  const shown = (id: ComposerMenuItem['id']) => items.find(item => item.id === id);
  const activityLabel = sessionActivityLabel({ session, replica: state, now: Date.now() }, false, t);
  const settingEntries: ComposerMenuEntry[] = [
    ...(shown('model') ? [{ id: 'model', label: categoryLabel('model'), testId: 'session-model-button', text: t('composer.model'),
      title: t('composer.modelTitle', { value: modelLabel ?? unavailable }), expanded: view === 'model', disabled: !shown('model')!.enabled, attention: categoryUnread('model'),
      detail: <span className={categoryPending('model') ? 'agent-setting-pending' : undefined}>{modelLabel && modelLabel !== unavailable ? modelLabel : null}</span>,
      run: () => onView(view === 'model' ? undefined : 'model') }] : []),
    ...(shown('permissions') ? [{ id: 'permissions', label: categoryLabel('permissions'), testId: 'session-permissions-button', text: t('composer.permissions'),
      title: t('composer.permissionsTitle', { value: permissions.length ? permissions.map(setting => selectedLabel(setting, unavailable)).join(' · ') : unavailable }),
      expanded: view === 'permissions', disabled: !shown('permissions')!.enabled, attention: categoryUnread('permissions'),
      detail: <span className={categoryPending('permissions') ? 'agent-setting-pending' : undefined}>{permissionLabel || null}</span>,
      run: () => onView(view === 'permissions' ? undefined : 'permissions') }] : []),
    // The Status row says what the session is doing; it opens the session's facts.
    ...(shown('status') ? [{ id: 'status', label: t('composer.status'), title: t('composer.statusTitle'), expanded: view === 'status', disabled: !shown('status')!.enabled,
      detail: <span>{activityLabel ?? null}</span>,
      run: () => onView(view === 'status' ? undefined : 'status') }] : []),
  ];
  return <div className="agent-session-controls" ref={layer}>
    {presentation === 'list' ? <div className="agent-session-settings-list"><ComposerMenuItems entries={settingEntries} /></div>
      : <ComposerMenu entries={[...entries, ...settingEntries]} open={view === 'actions'} onOpen={open => onView(open ? 'actions' : undefined)} />}
    <section hidden={!view || view === 'actions'} className="agent-session-panel" aria-label={view === 'status' ? t('composer.settings.status') : view === 'model' ? t('composer.settings.model') : t('composer.settings.permissions')}>
      <div className="agent-session-panel-heading"><strong>{view === 'status' ? t('composer.settings.status') : view === 'model' ? t('composer.settings.model') : t('composer.settings.permissions')}</strong><button type="button" aria-label={t('composer.settings.close')} onClick={() => { onView(undefined); restoreFocus(); }}>{t('common.close')}</button></div>
      {recovery}
      <div hidden={view !== 'status'}>{children}</div>
      {view === 'status' ? <><dl className="agent-session-facts">
          <dt>{t('composer.settings.provider')}</dt><dd>{agent.providerId}</dd><dt>{t('composer.settings.session')}</dt><dd>{agent.runtimeInfo.sessionId ?? unavailable}</dd>
          <dt>{t('composer.settings.connection')}</dt><dd>{disconnected ? unavailable : connectionLabel(runtimeConnection?.state, t)}</dd><dt>{t('composer.settings.runtime')}</dt><dd>{disconnected || !runtimeConnected ? t('composer.settings.lastKnown', { value: activityLabel ?? unavailable }) : activityLabel ?? unavailable}</dd>
          <dt>{t('composer.settings.directory')}</dt><dd>{agent.runtimeInfo.cwd ?? unavailable}</dd>
          {settings.map((setting) => <div key={setting.id}><dt>{setting.label}</dt><dd>{selectedLabel({ ...setting, value: setting.value ?? changeFor(setting)?.confirmedValue ?? null }, unavailable)}</dd></div>)}
        </dl><AgentSessionUsage usage={agent.lastUsage} lastKnown={disconnected || !runtimeConnected} /></>
        : <>
          {shownSettings.filter(({ category }) => category === view).map((setting) => {
            const settingChange = changeFor(setting);
            const pending = settingChange?.status === 'pending';
            const noteId = `${id}-${setting.id}-change`;
            const original = settings.find(original => original.id === setting.id)!;
            const actual = selectedLabel({ ...original, value: original.value ?? settingChange?.confirmedValue ?? null }, unavailable);
            const message = settingChange?.message ?? (settingChange?.status === 'timed_out' ? t('composer.settings.notConfirmed') : t('composer.settings.notApplied'));
            const publicRecovery = settingChange && !pending && settingChange.code === 'reauthentication_required'
              ? renderError?.(Object.assign(new Error(message), { code: settingChange.code })) : undefined;
            return <div className="agent-session-setting" key={setting.id} data-setting-state={pending ? 'pending' : undefined}>
              <label htmlFor={`${id}-${setting.id}`}>{setting.label}</label>
              <select id={`${id}-${setting.id}`} aria-label={setting.label} aria-describedby={settingChange ? noteId : undefined} data-testid={`session-setting-${setting.id}`} value={setting.value ?? ''}
                disabled={!canChange || !setting.mutable} onChange={(event) => void change(setting, event.target.value)}>
                {!setting.options.some(({ value }) => value === setting.value) ? <option value={setting.value ?? ''}>{setting.value ?? unavailable}</option> : null}
                {setting.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {settingChange ? <div id={noteId} className={`agent-composer-note${pending ? ' agent-setting-pending' : ''}`}>
                {pending ? t('composer.settings.pendingCurrent', { value: actual }) : publicRecovery ?? message}
              </div> : null}
              {setting.description ? <span className="agent-composer-note">{setting.description}</span> : null}
              {setting.options.find(({ value }) => value === setting.value)?.description ? <span className="agent-composer-note">{setting.options.find(({ value }) => value === setting.value)?.description}</span> : null}
              {setting.scope === 'session_and_default' ? <span className="agent-setting-scope">{t('composer.settings.alsoDefault')}</span> : null}
            </div>;
          })}
          {changes.filter(change => change.category === view && !settings.some(setting => setting.id === change.settingId)).map(change => {
            const pending = change.status === 'pending';
            const message = change.message ?? (change.status === 'timed_out' ? t('composer.settings.notConfirmed') : t('composer.settings.notApplied'));
            const publicRecovery = !pending && change.code === 'reauthentication_required'
              ? renderError?.(Object.assign(new Error(message), { code: change.code })) : undefined;
            return <div className="agent-session-setting" key={change.settingId} data-setting-state={pending ? 'pending' : undefined}>
              <span>{change.label}</span>
              {pending ? <span className="agent-setting-pending">{change.targetValue}</span> : null}
              <div className={`agent-composer-note${pending ? ' agent-setting-pending' : ''}`}>
                {pending ? t('composer.settings.pendingCurrent', { value: change.confirmedValue ?? unavailable }) : publicRecovery ?? message}
              </div>
            </div>;
          })}
          {settings.some(({ category }) => category === view) ? <p className="agent-composer-note" role="status">{readOnly ? t('composer.settings.readOnly') : busy ? t('composer.settings.submitting') : runtimeUnavailable ?? (disconnected ? t('composer.settings.disconnected') : !canChange ? t('composer.settings.unavailable') : t('composer.settings.applyOnConfirm'))}</p>
            : <p className="agent-composer-note">{t('composer.settings.notExposed')}</p>}
        </>}
      {failure && !recovery ? <p role="alert" className="agent-composer-note">{failure.message}</p> : null}
    </section>
  </div>;
}

function connectionLabel(state: 'connected' | 'reconnecting' | 'restoring' | 'unavailable' | undefined, t: Translate): string {
  if (state === 'reconnecting') return t('composer.settings.reconnecting');
  if (state === 'restoring') return t('composer.settings.restoring');
  if (state === 'unavailable') return t('common.unavailable');
  return t('composer.settings.connected');
}

function settingsRecoveryMessage(state: 'connected' | 'reconnecting' | 'restoring' | 'unavailable' | undefined, t: Translate): string | undefined {
  if (state === 'reconnecting') return t('composer.settings.runtimeReconnecting');
  if (state === 'restoring') return t('composer.settings.runtimeRestoring');
  if (state === 'unavailable') return t('composer.settings.runtimeUnavailable');
  return undefined;
}

function selectedLabel(setting: AgentSessionSetting, unavailable: string): string {
  return setting.options.find(({ value }) => value === setting.value)?.label ?? setting.value ?? unavailable;
}

function displayedValue(setting: AgentSessionSetting, change?: AgentSessionSettingChange): string | null {
  return change?.status === 'pending' ? change.targetValue : setting.value ?? change?.confirmedValue ?? null;
}
