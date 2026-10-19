import { createPortal } from 'react-dom';
import { useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { RemoteTeamClient } from '@orchardworks/agent-remote-web/headless';
import type { Team, TeamAction, TeamSource } from '@orchardworks/agent-remote-protocol';
import { workspaceFetch } from '../workspace-access.js';
import { useTrackingPosition } from '../hooks/useTrackingPosition.js';
import { ConversationConnectionScope } from '../conversation-connections.js';
import { useWindowLayout } from '../window-workspace-context.js';
import './team.css';

interface Host { teamManagement?: true; id: string; name: string; online: boolean; providers?: Array<{providerId:string;displayName:string}> }
interface Props {
  baseUrl: string; enabled: boolean; visible?: boolean; hosts: Host[]; source?: TeamSource;
  compact?: boolean; currentSession?: Pick<TeamSource, 'providerId' | 'nativeSessionId'> & { hostId?: string };
  sourceViewId?: string;
  reveal?: { teamId: string; requestId: string };
  onOpen(team: Team, sourceViewId?: string): Promise<boolean>; onOpenSession(target: TeamSource & { teamId?: string; teamMemberId?: string }): Promise<boolean>;
  onTeamsChange?(baseUrl: string, teams: Team[]): void;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Team operation failed.';
const isCurrentMember = (member: Team['members'][number], current: Props['currentSession']) => !!current
  && member.hostId === (current.hostId ?? 'local') && member.providerId === current.providerId && member.nativeSessionId === current.nativeSessionId;
export function TeamMenu(props: Props) {
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

  const { root, style, handlers } = useTrackingPosition('agent-remote:team-position');
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
  useEffect(() => {
    ++generation.current;
    if (!enabled) { setLoading(false); return; }
    let stopped = false, inFlight = false;
    const load = async () => { if (stopped || inFlight || document.visibilityState === 'hidden') return; inFlight = true;
      try { await refresh(); }
      catch (error) { if (!stopped) setLoadError(errorMessage(error)); } finally { inFlight = false; if (!stopped) setLoading(false); }
    };
    setLoading(true); void load(); const timer = setInterval(() => void load(), 4000);
    document.addEventListener('visibilitychange', load);
    return () => { stopped = true; ++generation.current; clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [client, enabled, baseUrl]);
  useEffect(() => {
    // Temporary access or catalog failures must not discard the last confirmed retention set.
    if (!enabled || rosterClient !== client) return;
    connections?.retainSessions('team-leaders', teams.filter(team => team.status !== 'archived').flatMap(team => team.members
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
    try { await action(); return true; } catch (error) { if (currentClient.current === client) setError(errorMessage(error)); return false; }
    finally { ++generation.current; mutating.current = false; setBusy(false); }
  }
  async function change(input: TeamAction) {
    const updated = await client.action(input); if (currentClient.current !== client) return;
    setTeams(current => [...current.filter(value => value.id !== updated.id), updated]);
    setRosterClient(client);
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
    if (!await currentPresentation.current.onOpen(created, sourceViewId)) throw new Error('The Team layout could not be opened. Retry after the main session is ready.');
    setSelected(created.id); setOpen(false); setRevealing(false);
  }
  async function openTeam(team: Team, sourceViewId?: string) {
    if (!await props.onOpen(team, sourceViewId)) throw new Error('The Team layout could not be opened. Retry after the main session is ready.');
    setSelected(team.id); setOpen(false); setRevealing(false);
  }
  async function openSession(target: TeamSource) {
    if (!await props.onOpenSession(target)) throw new Error('The session could not be opened.');
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
          management={<TeamManagement team={item} hosts={hosts} busy={busy} failure={error} onChange={input => run(() => change(input))} onOpenSession={target => void run(() => openSession(target))} />} />)}</ul></section>;
    });
  }
  if (!enabled) return null;
  return <>
    <div ref={root} data-hidden={!visible || undefined} aria-hidden={!visible || undefined} style={style} {...handlers} className="lab-tracking-floating lab-team-floating" onKeyDown={event => { handlers.onKeyDown?.(event); if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } }}>
      <button ref={trigger} className="lab-session-popover-trigger" aria-expanded={open} aria-label="Teams" onClick={() => { setOpen(!open); setRevealing(false); void refresh().catch(error => setError(errorMessage(error))); }}><span>Team</span><span>{teams.filter(item => item.status !== 'archived').length}</span></button>
      {open ? <section className="lab-session-popover-panel lab-tpm-panel" aria-label="Teams">
        <div className="lab-directory-heading"><h2>Teams</h2><button onClick={() => setOpen(false)} aria-label="Close Teams">×</button></div>
        {loading && !teams.length ? <p role="status">Loading teams…</p> : null}
        {groups(false)}
        {!teams.some(item => item.status !== 'archived') ? <p className="lab-control-note">Start with a Leader. Discuss the work, then add members.</p> : null}
        {teams.some(item => item.status === 'archived') ? <details><summary>Archived</summary>{groups(true)}</details> : null}
        {pendingCreate?.source || source ? <p className="lab-control-note" data-creation-source>For: <strong>{(pendingCreate?.source ?? source)!.title}</strong></p> : null}
        <button type="button" disabled={busy || !(pendingCreate?.source ?? source) || !hosts.some(host => host.id === (pendingCreate?.source ?? source)?.hostId && host.teamManagement && host.online)} onClick={() => void run(create)}>{pendingCreate ? 'Check previous creation' : 'New team'}</button>
        {!source || source.hostId === 'local' ? <p className="lab-control-note">Open a session on a connected Host to create a Team.</p> : null}
        {error || loadError ? <p role="alert">{error || loadError}</p> : null}
      </section> : null}
    </div>
  </>;
}

function TeamSessionNavigation({ team, hosts, busy, currentSession, onOpen }: {
  team: Team; hosts: Host[]; busy: boolean; currentSession: Props['currentSession']; onOpen(target: TeamSource & { teamId?: string; teamMemberId?: string }): void;
}) {
  return <nav className="lab-team-session-navigation" aria-label={`${team.title} sessions`}>
    {team.members.filter(member => member.creation !== 'abandoned').map(member => <button key={member.id} type="button"
      disabled={busy || member.creation !== 'ready' || !member.nativeSessionId}
      aria-current={isCurrentMember(member, currentSession) ? 'page' : undefined}
      onClick={() => onOpen({ teamId: team.id, teamMemberId: member.id, hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId!, title: member.name })}>
      <span>{member.name}</span><small>{member.role === 'leader' ? 'Leader' : 'Member'} · {hosts.find(host => host.id === member.hostId)?.name ?? member.hostId}{member.creation !== 'ready' ? ' · Not ready' : !member.nativeSessionId ? ' · Execution unavailable' : ''}</small>
    </button>)}
  </nav>;
}

function TeamListItem({ team, selected, busy, onOpen, onRename, navigation, management }: {
  team: Team; selected: boolean; busy: boolean; onOpen(): void; onRename(title: string): Promise<boolean>; navigation?: ReactNode; management: ReactNode;
}) {
  const [editing, setEditing] = useState(false), [title, setTitle] = useState('');
  const renameButton = useRef<HTMLButtonElement>(null);
  function close() { setEditing(false); renameButton.current?.focus(); }
  return <li data-team-id={team.id}>
    <div className="lab-team-list-row">
      <button type="button" className="lab-session-row" aria-current={selected || undefined} onClick={onOpen}>
        <span className="lab-tracked-description"><strong>{team.title}</strong><small>{team.members.length} {team.members.length === 1 ? 'worker' : 'workers'}{team.status !== 'active' ? ` · ${team.status}` : ''}</small></span>
      </button>
      <button ref={renameButton} type="button" className="lab-team-rename" disabled={busy} aria-label="Rename Team" title={`Rename ${team.title}`} onClick={() => { setTitle(team.title); setEditing(true); }}>Rename</button>
    </div>
    {editing ? <form className="lab-team-form lab-team-rename-form" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close(); }
    }} onSubmit={event => {
      event.preventDefault();
      if (!title.trim() || busy) return;
      if (title.trim() === team.title) { close(); return; }
      void onRename(title.trim()).then(ok => { if (ok) close(); });
    }}>
      <label>Team name<input autoFocus disabled={busy} value={title} maxLength={256} required onChange={event => setTitle(event.target.value)} /></label>
      <div><button type="button" disabled={busy} onClick={close}>Cancel</button><button disabled={busy || !title.trim()}>Save</button></div>
    </form> : null}
    {navigation}
    {management}
  </li>;
}

function TeamManagement({ team, hosts, busy, failure, onChange, onOpenSession }: {
  team: Team; hosts: Host[]; busy: boolean; failure?: string; onChange(input: TeamAction): Promise<boolean>; onOpenSession(target: TeamSource & { teamId?: string; teamMemberId?: string }): void;
}) {
  const [adding, setAdding] = useState(false);
  const recovery = [...team.messages.filter(message => ['unknown', 'dispatching', 'rejected'].includes(message.status)
    || message.status === 'accepted' && !['started', 'handled'].includes(message.acceptance ?? '')), ...(team.unresolvedReceipts ?? [])];
  return <details className="lab-team-management"><summary>Manage team</summary>
    <div className="lab-team-actions">
      <button disabled={busy || team.status !== 'active'} onClick={() => setAdding(!adding)}>Add member</button>
      <button disabled={busy || team.status === 'archiving'} onClick={() => void onChange({teamId:team.id,action:team.status === 'archived' ? 'restore' : 'archive'})}>{team.status === 'archived' ? 'Restore' : team.status === 'archiving' ? 'Archiving…' : 'Archive'}</button>
      <button disabled={busy} onClick={() => onOpenSession(team.source)}>Open main session</button>
    </div>
    {adding ? <AddTeamMember failure={failure} teamId={team.id} hosts={hosts.filter(host => host.teamManagement)} busy={busy} onChange={onChange} onClose={() => setAdding(false)} /> : null}
    <ul className="lab-team-members">{team.members.filter(member => member.creation !== 'abandoned').map(member => <li key={member.id}>
      <button disabled={busy || member.creation !== 'ready' || !member.nativeSessionId} onClick={() => onOpenSession({teamId:team.id,teamMemberId:member.id,hostId:member.hostId,providerId:member.providerId,nativeSessionId:member.nativeSessionId!,title:member.name})}>{member.name}</button>
      <small>{member.role} · {hosts.find(host => host.id === member.hostId)?.name ?? member.hostId} · {member.activity}</small>
      {member.responsibility || member.cwd || member.summary ? <details><summary>Details</summary>{member.responsibility}{member.cwd ? <p>{member.cwd}</p> : null}{member.summary ? <p>{member.summary}</p> : null}</details> : null}
      {member.creation === 'ready' && !member.nativeSessionId ? <p>The current execution locator is unavailable. History and drafts are preserved.</p> : null}
      {member.creation !== 'ready' ? <div><p>{member.error ?? 'Session creation is pending.'}</p><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'retry_creation',memberId:member.id})}>Check creation</button><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'abandon_creation',memberId:member.id})}>Abandon slot</button></div> : null}
    </li>)}</ul>
    {team.status === 'archiving' ? <p className="lab-control-note" role="status">New dispatches stopped. Waiting for members to settle. Open their sessions to resolve approvals or stop ongoing work.</p> : null}
    {recovery.length > 0 ? <details className="lab-team-recovery"><summary>Delivery status</summary>{recovery.map(message => <div key={message.id}>{!('text' in message) ? <><p>Delivery {message.id} to {team.members.find(member => member.id === message.to)?.name ?? message.to}</p>{message.resolvedTarget ? <small>Recorded recipient: {message.resolvedTarget.nativeSessionId}</small> : null}</> : null}<p>{message.status}: {'text' in message ? message.text.slice(0,160) : 'Original message body is unavailable.'}</p><small>{message.error ?? 'Awaiting a native receipt. Do not repeat this message.'}</small>{message.status !== 'rejected' ? <><p>Inspect the receiving session before resolving.</p><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'resolve_message',messageId:message.id,outcome:'accepted'})}>Confirm received</button><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'resolve_message',messageId:message.id,outcome:'rejected'})}>Confirm not executed</button></> : null}</div>)}</details> : null}
  </details>;
}

function AddTeamMember({ teamId, hosts, busy, failure, onChange, onClose }: {teamId:string;hosts:Host[];busy:boolean;failure?:string;onChange(input:TeamAction):Promise<boolean>;onClose():void}) {
  const [hostId,setHostId] = useState(hosts.find(host => host.online)?.id ?? ''), [providerId,setProviderId] = useState(''), [name,setName] = useState(''), [cwd,setCwd] = useState(''), [responsibility,setResponsibility] = useState('');
  const operation = useRef<{ signature: string; id: string }>();
  const dialog = useRef<HTMLDialogElement>(null), label = useId();
  const [error, setError] = useState('');
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  const host = hosts.find(host => host.id === hostId), providers = host?.providers ?? [];
  const provider = providers.some(value => value.providerId === providerId) ? providerId : providers[0]?.providerId ?? '';
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog" data-team-dialog aria-labelledby={label}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={label}>Add member</h2><button type="button" aria-label="Close member editor" disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={event => {
      event.preventDefault(); if (busy) return;
      const fields = {hostId,providerId:provider,name:name.trim() || host?.name || 'Member',cwd:cwd.trim(),responsibility};
      const signature = JSON.stringify(fields);
      if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
      setError('');
      void onChange({action:'add_member',teamId,operationId:operation.current.id,...fields}).then(ok => { if (ok) onClose(); else setError('The member could not be added. Retry to check the same request.'); });
    }}>
    <label>Host<select disabled={busy} value={hostId} onChange={event => {setHostId(event.target.value);}}>{hosts.map(host => <option key={host.id} value={host.id} disabled={!host.online}>{host.name}{!host.online ? ' · Offline' : ''}</option>)}</select></label>
    <label>Provider<select disabled={busy} value={provider} onChange={event => {setProviderId(event.target.value);}}>{providers.map(provider => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}</select></label>
    <label>Name<input disabled={busy} maxLength={256} value={name} placeholder="Optional" onChange={event => setName(event.target.value)} /></label>
    <label>Working directory<input disabled={busy} maxLength={2048} value={cwd} placeholder="Host default directory" onChange={event => setCwd(event.target.value)} /></label>
    <label>Responsibility<textarea disabled={busy} maxLength={2048} value={responsibility} placeholder="Can be discussed with the Leader after joining" onChange={event => setResponsibility(event.target.value)} /></label>
    {failure || error ? <p role="alert">{failure || error}</p> : null}
    <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="lab-favorite-primary" disabled={busy || !host?.online || !provider}>Add member</button></footer>
  </form></dialog>, document.body);
}
