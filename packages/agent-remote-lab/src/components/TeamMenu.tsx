import { createPortal } from 'react-dom';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { Translate } from '@orchardworks/agent-client';
import { enumWords, memberActivityWords, memberRoleWords, messageStatusWords, teamStatusWords } from '../team-words.js';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorWords, RemoteTeamClient, watchList } from '@orchardworks/agent-client';
import type { Team, TeamAction, TeamSource } from '@orchardworks/agent-remote-protocol';
import { workspaceFetch } from '../workspace-access.js';
import { useTrackingPosition } from '../hooks/useTrackingPosition.js';
import { ConversationConnectionScope } from '../conversation-connections.js';
import { ShortcutPlacement } from '../shell/shortcut-placement.js';
import { useWindowLayout } from '../window-workspace-context.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { WorkspaceSelect, type WorkspaceSelection } from './WorkspaceSelect.js';
import { SupportGroup, usageText } from './call-for-support/SupportGroup.js';
import { SupportSession } from './call-for-support/SupportSession.js';
import './team.css';

interface Host { teamManagement?: true; id: string; name: string; online: boolean; providers?: Array<{providerId:string;displayName:string}> }
interface Props {
  baseUrl: string; enabled: boolean; visible?: boolean; hosts: Host[]; source?: TeamSource;
  /** A Team member's conversation is open: its seat follows the member's successor through the roster, which then refreshes closely. */
  following?: boolean;
  compact?: boolean; currentSession?: Pick<TeamSource, 'providerId' | 'nativeSessionId'> & { hostId?: string };
  sourceViewId?: string;
  reveal?: { teamId: string; requestId: string };
  onOpen(team: Team, sourceViewId?: string): Promise<boolean>; onOpenSession(target: TeamSource & { teamId?: string; teamMemberId?: string }): Promise<boolean>;
  onTeamsChange?(baseUrl: string, teams: Team[]): void;
}
/** How often the Team roster refreshes while someone looks at it or a Team is forming (`watchingMs`), and otherwise (`idleMs`). */
export interface TeamRefreshPeriods { watchingMs: number; idleMs: number }
export const TEAM_REFRESH_PERIODS: TeamRefreshPeriods = { watchingMs: 4_000, idleMs: 30_000 };
/** The periods the roster refreshes at; a page keeps `TEAM_REFRESH_PERIODS`, and a test passes shorter ones instead of waiting them out. */
export const TeamRefresh = createContext<TeamRefreshPeriods>(TEAM_REFRESH_PERIODS);
const errorMessage = (t: Translate, error: unknown) => errorWords(error, t, 'team.team.operationFailed');
const isCurrentMember = (member: Team['members'][number], current: Props['currentSession']) => !!current
  && member.hostId === (current.hostId ?? 'local') && member.providerId === current.providerId && member.nativeSessionId === current.nativeSessionId;
export function TeamMenu(props: Props) {
  const t = useTranslate();
  const { baseUrl, enabled, visible = true, hosts, source } = props;
  const client = useMemo(() => new RemoteTeamClient(baseUrl, workspaceFetch), [baseUrl]);
  const layout = useWindowLayout();
  const currentPresentation = useRef({ layout, onOpen: props.onOpen }); currentPresentation.current = { layout, onOpen: props.onOpen };
  const connections = useContext(ConversationConnectionScope);
  const [rosterClient, setRosterClient] = useState<RemoteTeamClient>();
  const [teams, setTeams] = useState<Team[]>([]), [selected, setSelected] = useState('');
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [revealing, setRevealing] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<{operationId:string;source:TeamSource;sourceViewId?:string;origin?:{windowId:string;viewId:string}}>();

  const placement = useContext(ShortcutPlacement), floating = placement === 'floating';
  const { root, style, handlers, edge } = useTrackingPosition('agent-remote:team-position', undefined, { enabled: floating });
  const rootProps = floating ? { style, ...handlers, 'data-edge': edge, className: 'lab-tracking-floating lab-team-floating' }
    : placement === 'bar' ? { className: 'lab-launcher lab-launcher-team' } : { className: 'lab-sidebar-shortcut lab-sidebar-shortcut-team' };
  const trigger = useRef<HTMLButtonElement>(null);
  const revealedRequest = useRef<string>();
  const currentClient = useRef(client); currentClient.current = client;
  const generation = useRef(0), mutating = useRef(false);
  const refresh = async () => {
    if (mutating.current) return;
    const ticket = ++generation.current;
    const value = await client.list();
    if (currentClient.current === client && ticket === generation.current) { setTeams(value); setRosterClient(client); setLoadError(''); }
  };
  useEffect(() => {
    setTeams([]); setRosterClient(undefined); setSelected(''); setError(''); setLoadError(''); setPendingCreate(undefined);
  }, [client]);
  const loader = useRef<() => Promise<void>>();
  useEffect(() => {
    ++generation.current;
    if (!enabled) { setLoading(false); return; }
    let stopped = false, inFlight = false;
    const load = async () => { if (stopped || inFlight || document.visibilityState === 'hidden') return; inFlight = true;
      try { await refresh(); }
      catch (error) { if (!stopped) setLoadError(errorMessage(t, error)); } finally { inFlight = false; if (!stopped) setLoading(false); }
    };
    loader.current = load;
    setLoading(true);
    const unwatch = watchList(load);
    return () => { stopped = true; ++generation.current; if (loader.current === load) loader.current = undefined; unwatch(); };
  }, [client, enabled, baseUrl]);
  // The roster follows changes closely while someone looks at it, a Team is forming or a member's conversation is open (its
  // seat follows the member's successor through the roster); otherwise it stays current for
  // roles and attention twice a minute instead of polling every few seconds on every open page (stage 6).
  const forming = !!pendingCreate || teams.some(team => team.status === 'active' && team.members.some(member => member.creation === 'reserved'));
  const watching = open || revealing || forming || !!props.following;
  const periods = useContext(TeamRefresh);
  useEffect(() => {
    if (!enabled) return;
    // Something to follow just appeared (a member's conversation opened, a Team began forming): refresh at once.
    if (watching) void loader.current?.();
    const timer = setInterval(() => void loader.current?.(), watching ? periods.watchingMs : periods.idleMs);
    return () => clearInterval(timer);
  }, [client, enabled, baseUrl, watching, periods]);
  useEffect(() => {
    // Temporary access or catalog failures must not discard the last confirmed retention set.
    if (!enabled || rosterClient !== client) return;
    // Support coordinators are not kept connected: their runtimes are released while idle.
    connections?.retainSessions('team-leaders', teams.filter(team => team.status !== 'archived' && !team.callForSupport).flatMap(team => team.members
      .filter(member => member.role === 'leader' && member.creation === 'ready' && member.nativeSessionId)
      .map(member => ({ hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId! }))));
  }, [connections, client, rosterClient, enabled, teams]);
  useEffect(() => () => connections?.retainSessions('team-leaders', []), [connections, client]);
  useEffect(() => {
    if (rosterClient === client) props.onTeamsChange?.(baseUrl, teams);
  }, [baseUrl, client, rosterClient, teams, props.onTeamsChange]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  useEffect(() => {
    if (!enabled || !visible || !props.reveal) return;
    setOpen(true); setSelected(props.reveal.teamId); setRevealing(true);
  }, [enabled, visible, props.reveal?.teamId, props.reveal?.requestId]);
  useEffect(() => {
    if (!enabled || !visible || !open || !props.reveal) return;
    const key = JSON.stringify([baseUrl, props.reveal.teamId, props.reveal.requestId]);
    if (revealedRequest.current === key) return;
    const row = [...root.current?.querySelectorAll<HTMLElement>('[data-team-id]') ?? []].find(row => row.dataset.teamId === props.reveal!.teamId);
    const target = row?.querySelector<HTMLButtonElement>('.lab-session-row');
    if (!row || !target) return;
    for (let parent = row.parentElement; parent && root.current?.contains(parent); parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'nearest' });
    revealedRequest.current = key;
  }, [baseUrl, enabled, visible, open, teams, root, props.reveal?.teamId, props.reveal?.requestId]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest('[data-team-dialog]'))) setOpen(false); };
    document.addEventListener('pointerdown', dismiss); return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, root]);
  async function run(action: () => Promise<void>) {
    if (mutating.current) return false;
    mutating.current = true; ++generation.current; setBusy(true); setError('');
    try { await action(); return true; } catch (error) { if (currentClient.current === client) setError(errorMessage(t, error)); return false; }
    finally { ++generation.current; mutating.current = false; setBusy(false); }
  }
  async function change(input: TeamAction) {
    const updated = await client.action(input); if (currentClient.current !== client) return;
    setTeams(current => [...current.filter(value => value.id !== updated.id), updated]);
    setRosterClient(client);
  }
  async function remove(teamId: string) {
    await client.delete(teamId); if (currentClient.current !== client) return;
    setTeams(current => current.filter(value => value.id !== teamId));
  }
  async function create() {
    if (!source && !pendingCreate) return;
    const input = pendingCreate ?? { operationId: crypto.randomUUID(), source: structuredClone(source!), sourceViewId: props.sourceViewId,
      ...(layout?.window.selectedViewId ? { origin: { windowId: layout.window.id, viewId: layout.window.selectedViewId } } : {}) }; setPendingCreate(input);
    const { sourceViewId, origin, ...request } = input;
    const created = await client.create(request); if (currentClient.current !== client) return;
    setTeams(current => [...current.filter(value => value.id !== created.id), created]); setRosterClient(client); setPendingCreate(undefined);
    if (origin) {
      const current = currentPresentation.current.layout?.window;
      const binding = current?.id === origin.windowId ? current.views.find(view => view.id === origin.viewId)?.binding : undefined;
      if (!binding || binding.hostId !== input.source.hostId || binding.providerId !== input.source.providerId || binding.nativeSessionId !== input.source.nativeSessionId) return;
    }
    if (!await currentPresentation.current.onOpen(created, sourceViewId)) throw new Error(t('team.team.layoutNotOpened'));
    setSelected(created.id); setOpen(false); setRevealing(false);
  }
  async function openTeam(team: Team, sourceViewId?: string) {
    if (!await props.onOpen(team, sourceViewId)) throw new Error(t('team.team.layoutNotOpened'));
    setSelected(team.id); setOpen(false); setRevealing(false);
  }
  async function openSession(target: TeamSource) {
    if (!await props.onOpenSession(target)) throw new Error(t('team.team.sessionNotOpened'));
    setOpen(false); setRevealing(false);
  }
  function groups(archived: boolean) {
    const items = teams.filter(team => (team.status === 'archived') === archived);
    const keys = [...new Set(items.map(team => JSON.stringify([team.source.hostId, team.source.providerId, team.source.nativeSessionId])))];
    return keys.map(key => { const group = items.filter(team => JSON.stringify([team.source.hostId, team.source.providerId, team.source.nativeSessionId]) === key), main = group[0]!.source;
      return <section key={key} className="lab-tpm-group"><header className="lab-tpm-group-heading"><h3>{main.title}</h3><small>{hosts.find(host => host.id === main.hostId)?.name ?? main.hostId}</small></header>
        <ul className="lab-tpm-list">{group.map(item => <TeamListItem key={item.id} team={item} selected={!revealing && props.compact ? item.members.some(member => isCurrentMember(member, props.currentSession)) : selected === item.id} busy={busy}
          onOpen={() => void run(() => openTeam(item))} onRename={title => run(() => change({action:'rename',teamId:item.id,title}))}
          navigation={props.compact ? <TeamSessionNavigation team={item} hosts={hosts} busy={busy} currentSession={props.currentSession} onOpen={target => void run(() => openSession(target))} /> : undefined}
          management={item.callForSupport
            ? <SupportGroup team={item} hosts={hosts} busy={busy} onChange={input => run(() => change(input))} onDelete={() => run(() => remove(item.id))} onOpenSession={target => void run(() => openSession(target))} />
            : <TeamManagement baseUrl={baseUrl} team={item} hosts={hosts} busy={busy} failure={error} onChange={input => run(() => change(input))} onOpenSession={target => void run(() => openSession(target))} />} />)}</ul></section>;
    });
  }
  if (!enabled) return null;
  // A support roster waiting for approval or a role paused by its budget needs the user.
  const attention = teams.some(team => team.status === 'active' && (team.callForSupport?.roster?.status === 'pending' || team.callForSupport?.status === 'paused_budget'));
  return <>
    <div ref={root} data-hidden={!visible || undefined} aria-hidden={!visible || undefined} {...rootProps} onKeyDown={event => { if (floating) handlers.onKeyDown?.(event); if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } }}>
      <button ref={trigger} className="lab-session-popover-trigger" aria-expanded={open} aria-label={attention ? t('team.team.menuWaiting') : t('team.team.menu')} onClick={() => { setOpen(!open); setRevealing(false); void refresh().catch(error => setError(errorMessage(t, error))); }}><span>Team</span><span className="lab-team-count">{teams.filter(item => item.status !== 'archived').length}</span>{attention ? <span className="lab-support-badge" data-tone="warning" aria-hidden="true">!</span> : null}</button>
      {open ? <section className="lab-session-popover-panel lab-tpm-panel" aria-label={t('team.team.menu')}>
        <div className="lab-directory-heading"><h2>{t('team.team.menu')}</h2><button onClick={() => setOpen(false)} aria-label={t('team.team.closeMenu')}>×</button></div>
        {loading && !teams.length ? <p role="status">{t('team.team.loading')}</p> : null}
        {groups(false)}
        {!teams.some(item => item.status !== 'archived') ? <p className="lab-control-note">{t('team.team.empty')}</p> : null}
        {teams.some(item => item.status === 'archived') ? <details><summary>{t('team.team.archived')}</summary>{groups(true)}</details> : null}
        {pendingCreate?.source || source ? <p className="lab-control-note" data-creation-source>{t('team.for')} <strong>{(pendingCreate?.source ?? source)!.title}</strong></p> : null}
        {source && source.hostId !== 'local' && rosterClient === client ? <SupportSession baseUrl={baseUrl} source={source} teams={teams} teamClient={client} busy={busy}
          run={action => run(action)} onTeam={team => { setTeams(current => [...current.filter(value => value.id !== team.id), team]); setRosterClient(client); }} /> : null}
        <button type="button" disabled={busy || !(pendingCreate?.source ?? source) || !hosts.some(host => host.id === (pendingCreate?.source ?? source)?.hostId && host.teamManagement && host.online)} onClick={() => void run(create)}>{pendingCreate ? t('team.team.checkPreviousCreation') : t('team.team.new')}</button>
        {!source || source.hostId === 'local' ? <p className="lab-control-note">{t('team.team.needHost')}</p> : null}
        {error || loadError ? <p role="alert">{error || loadError}</p> : null}
      </section> : null}
    </div>
  </>;
}

const memberRole = (t: Translate, team: Team, member: Team['members'][number]) => member.role === 'requester' ? t('team.team.roleWorker')
  : member.role === 'leader' ? (team.callForSupport ? t('team.team.roleCoordinator') : t('team.team.roleLeader')) : team.callForSupport ? t('team.team.roleSupporter') : t('team.team.roleMember');

function TeamSessionNavigation({ team, hosts, busy, currentSession, onOpen }: {
  team: Team; hosts: Host[]; busy: boolean; currentSession: Props['currentSession']; onOpen(target: TeamSource & { teamId?: string; teamMemberId?: string }): void;
}) {
  const t = useTranslate();
  return <nav className="lab-team-session-navigation" aria-label={t('team.team.sessionsOf', { title: team.title })}>
    {team.members.filter(member => member.creation !== 'abandoned').map(member => <button key={member.id} type="button"
      disabled={busy || member.creation !== 'ready' && member.creation !== 'released' || !member.nativeSessionId}
      aria-current={isCurrentMember(member, currentSession) ? 'page' : undefined}
      onClick={() => onOpen({ teamId: team.id, teamMemberId: member.id, hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId!, title: member.name })}>
      <span>{member.name}</span><small>{memberRole(t, team, member)} · {hosts.find(host => host.id === member.hostId)?.name ?? member.hostId}{member.creation === 'released' ? ` · ${t('team.team.released')}` : member.creation !== 'ready' ? ` · ${t('team.team.notReady')}` : !member.nativeSessionId ? ` · ${t('team.team.executionUnavailable')}` : ''}</small>
    </button>)}
  </nav>;
}

function TeamListItem({ team, selected, busy, onOpen, onRename, navigation, management }: {
  team: Team; selected: boolean; busy: boolean; onOpen(): void; onRename(title: string): Promise<boolean>; navigation?: ReactNode; management: ReactNode;
}) {
  const t = useTranslate();
  const [editing, setEditing] = useState(false), [title, setTitle] = useState('');
  const renameButton = useRef<HTMLButtonElement>(null);
  function close() { setEditing(false); renameButton.current?.focus(); }
  return <li data-team-id={team.id}>
    <div className="lab-team-list-row">
      <button type="button" className="lab-session-row" aria-current={selected || undefined} onClick={onOpen}>
        <span className="lab-tracked-description"><strong>{team.title}</strong><small>{team.callForSupport
          ? `${team.callForSupport.status === 'paused_budget' ? t('team.team.supportPaused') : t('team.team.supportOpen', { count: team.callForSupport.calls.filter(call => call.status === 'open' || call.status === 'queued').length })}${team.callForSupport.roster?.status === 'pending' ? ` · ${t('team.team.rosterWaits')}` : ''} · ${usageText(team.callForSupport.usage, t)}`
          : t('team.team.workers', { count: team.members.length })}{team.status !== 'active' ? ` · ${enumWords(t, teamStatusWords, team.status)}` : ''}</small></span>
      </button>
      <button ref={renameButton} type="button" className="lab-team-rename" disabled={busy} aria-label={t('team.team.renameTeam')} title={t('team.team.renameNamed', { title: team.title })} onClick={() => { setTitle(team.title); setEditing(true); }}>{t('common.rename')}</button>
    </div>
    {editing ? <form className="lab-team-form lab-team-rename-form" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close(); }
    }} onSubmit={event => {
      event.preventDefault();
      if (!title.trim() || busy) return;
      if (title.trim() === team.title) { close(); return; }
      void onRename(title.trim()).then(ok => { if (ok) close(); });
    }}>
      <label>{t('team.team.name')}<input autoFocus disabled={busy} value={title} maxLength={256} required onChange={event => setTitle(event.target.value)} /></label>
      <div><button type="button" disabled={busy} onClick={close}>{t('common.cancel')}</button><button disabled={busy || !title.trim()}>{t('common.save')}</button></div>
    </form> : null}
    {navigation}
    {management}
  </li>;
}

function TeamManagement({ baseUrl, team, hosts, busy, failure, onChange, onOpenSession }: {
  baseUrl: string; team: Team; hosts: Host[]; busy: boolean; failure?: string; onChange(input: TeamAction): Promise<boolean>; onOpenSession(target: TeamSource & { teamId?: string; teamMemberId?: string }): void;
}) {
  const t = useTranslate();
  const [adding, setAdding] = useState(false);
  const recovery = [...team.messages.filter(message => ['unknown', 'dispatching', 'rejected'].includes(message.status)
    || message.status === 'accepted' && !['started', 'handled'].includes(message.acceptance ?? '')), ...(team.unresolvedReceipts ?? [])];
  return <details className="lab-team-management"><summary>{t('team.team.manage')}</summary>
    <div className="lab-team-actions">
      <button disabled={busy || team.status !== 'active'} onClick={() => setAdding(!adding)}>{t('team.team.addMember')}</button>
      <button disabled={busy || team.status === 'archiving'} onClick={() => void onChange({teamId:team.id,action:team.status === 'archived' ? 'restore' : 'archive'})}>{team.status === 'archived' ? t('team.team.restore') : team.status === 'archiving' ? t('team.team.archiving') : t('team.team.archive')}</button>
      <button disabled={busy} onClick={() => onOpenSession(team.source)}>{t('team.team.openMain')}</button>
    </div>
    {adding ? <AddTeamMember baseUrl={baseUrl} failure={failure} teamId={team.id} hosts={hosts.filter(host => host.teamManagement)} busy={busy} onChange={onChange} onClose={() => setAdding(false)} /> : null}
    <ul className="lab-team-members">{team.members.filter(member => member.creation !== 'abandoned').map(member => <li key={member.id}>
      <button disabled={busy || member.creation !== 'ready' || !member.nativeSessionId} onClick={() => onOpenSession({teamId:team.id,teamMemberId:member.id,hostId:member.hostId,providerId:member.providerId,nativeSessionId:member.nativeSessionId!,title:member.name})}>{member.name}</button>
      <small>{enumWords(t, memberRoleWords, member.role)} · {hosts.find(host => host.id === member.hostId)?.name ?? member.hostId} · {enumWords(t, memberActivityWords, member.activity)}</small>
      {member.responsibility || member.cwd || member.summary ? <details><summary>{t('common.details')}</summary>{member.responsibility}{member.cwd ? <p>{member.cwd}</p> : null}{member.summary ? <p>{member.summary}</p> : null}</details> : null}
      {member.creation === 'ready' && !member.nativeSessionId ? <p>{t('team.team.locatorUnavailable')}</p> : null}
      {member.creation !== 'ready' ? <div><p>{member.error ?? t('team.team.creationPending')}</p><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'retry_creation',memberId:member.id})}>{t('team.team.checkCreation')}</button><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'abandon_creation',memberId:member.id})}>{t('team.team.abandonSlot')}</button></div> : null}
    </li>)}</ul>
    {team.status === 'archiving' ? <p className="lab-control-note" role="status">{t('team.team.archivingNote')}</p> : null}
    {recovery.length > 0 ? <details className="lab-team-recovery"><summary>{t('team.team.deliveryStatus')}</summary>{recovery.map(message => <div key={message.id}>{!('text' in message) ? <><p>{t('team.team.deliveryTo', { id: message.id, name: team.members.find(member => member.id === message.to)?.name ?? message.to })}</p>{message.resolvedTarget ? <small>{t('team.team.recordedRecipient', { id: message.resolvedTarget.nativeSessionId })}</small> : null}</> : null}<p>{enumWords(t, messageStatusWords, message.status)}: {'text' in message ? message.text.slice(0,160) : t('team.team.bodyUnavailable')}</p><small>{message.error ?? t('team.team.awaitingReceipt')}</small>{message.status !== 'rejected' ? <><p>{t('team.team.inspectReceiver')}</p><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'resolve_message',messageId:message.id,outcome:'accepted'})}>{t('team.team.confirmReceived')}</button><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'resolve_message',messageId:message.id,outcome:'rejected'})}>{t('team.team.confirmNotExecuted')}</button></> : null}</div>)}</details> : null}
  </details>;
}

function AddTeamMember({ baseUrl, teamId, hosts, busy, failure, onChange, onClose }: {baseUrl:string;teamId:string;hosts:Host[];busy:boolean;failure?:string;onChange(input:TeamAction):Promise<boolean>;onClose():void}) {
  const [hostId,setHostId] = useState(hosts.find(host => host.online)?.id ?? ''), [providerId,setProviderId] = useState(''), [name,setName] = useState(''), [responsibility,setResponsibility] = useState('');
  const directory = useMemo(() => new SessionDirectoryClient(baseUrl, workspaceFetch, hostId), [baseUrl, hostId]);
  const [workspace, setWorkspace] = useState<{ directory: SessionDirectoryClient; providerId: string; value: WorkspaceSelection }>();
  const operation = useRef<{ signature: string; id: string }>();
  const dialog = useRef<HTMLDialogElement>(null), label = useId();
  const [error, setError] = useState('');
  const t = useTranslate();
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  const host = hosts.find(host => host.id === hostId), providers = host?.providers ?? [];
  const provider = providers.some(value => value.providerId === providerId) ? providerId : providers[0]?.providerId ?? '';
  useEffect(() => { setWorkspace(undefined); }, [directory, provider]);
  const selection = workspace?.directory === directory && workspace.providerId === provider ? workspace.value : {};
  const cwd = selection.path ?? '';
  const pathError = cwd.length > 2048 ? t('team.team.pathTooLong') : '';
  const canAdd = !busy && !!host?.online && !!provider && !!cwd && !pathError;
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog" data-team-dialog aria-labelledby={label}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={label}>{t('team.team.addMember')}</h2><button type="button" aria-label={t('team.team.closeEditor')} disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={event => {
      event.preventDefault(); if (!canAdd) return;
      const fields = {hostId,providerId:provider,name:name.trim() || host?.name || t('team.team.defaultMemberName'),cwd,responsibility};
      const signature = JSON.stringify(fields);
      if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
      setError('');
      void onChange({action:'add_member',teamId,operationId:operation.current.id,...fields}).then(ok => { if (ok) onClose(); else setError(t('team.team.memberNotAdded')); });
    }}>
    <label>{t('team.team.host')}<select disabled={busy} value={hostId} onChange={event => {setHostId(event.target.value);}}>{hosts.map(host => <option key={host.id} value={host.id} disabled={!host.online}>{host.name}{!host.online ? ` · ${t('common.offline')}` : ''}</option>)}</select></label>
    <label>{t('team.team.provider')}<select disabled={busy} value={provider} onChange={event => {setProviderId(event.target.value);}}>{providers.map(provider => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}</select></label>
    <label>{t('team.tpm.name')}<input disabled={busy} maxLength={256} value={name} placeholder={t('team.team.optional')} onChange={event => setName(event.target.value)} /></label>
    <WorkspaceSelect directory={directory} providerId={provider} disabled={busy || !host?.online} value={selection} required
      onChange={value => setWorkspace({ directory, providerId: provider, value })} />
    {pathError ? <p role="alert">{pathError}</p> : null}
    <label>{t('team.team.responsibility')}<textarea disabled={busy} maxLength={2048} value={responsibility} placeholder={t('team.team.responsibilityPlaceholder')} onChange={event => setResponsibility(event.target.value)} /></label>
    {failure || error ? <p role="alert">{failure || error}</p> : null}
    <footer><button type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="lab-favorite-primary" disabled={!canAdd}>{t('team.team.addMember')}</button></footer>
  </form></dialog>, document.body);
}
