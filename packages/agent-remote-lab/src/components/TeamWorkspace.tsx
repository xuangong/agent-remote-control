import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RemoteTeamClient, type RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import type { Team, TeamAction, TeamMember, TeamSource } from '@orchardworks/agent-remote-protocol';
import { workspaceFetch } from '../workspace-access.js';
import { useTrackingPosition } from '../hooks/useTrackingPosition.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import type { DraftBinding } from '../draft-store.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { TeamSessionFamily } from './TeamSessionFamily.js';
import { sessionKey } from '../session-tree.js';
import './team.css';

interface Host { teamManagement?: true; id: string; name: string; online: boolean; providers?: Array<{providerId:string;displayName:string}> }
interface Props {
  baseUrl: string; enabled: boolean; visible?: boolean; compact: boolean; hosts: Host[]; source?: TeamSource;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; navigation?: SessionViewNavigationFactory;
  mount: HTMLElement | null; onModeChange(active: boolean): void; viewTarget?(node: HTMLDivElement | null): void;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Team operation failed.';
function saved(scope: string) { try { return conversationSessionStorage.getItem(`agent-remote:team:${scope}`) ?? ''; } catch { return ''; } }

export function TeamWorkspace(props: Props) {
  const { baseUrl, enabled, visible = true, hosts, source, mount, onModeChange } = props;
  const client = useMemo(() => new RemoteTeamClient(baseUrl, workspaceFetch), [baseUrl]);
  const [teams, setTeams] = useState<Team[]>([]), [selected, setSelected] = useState(() => saved(baseUrl));
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [pendingCreate, setPendingCreate] = useState<{operationId:string;source:TeamSource}>();

  const { root, style, handlers } = useTrackingPosition('agent-remote:team-position');
  const trigger = useRef<HTMLButtonElement>(null);
  const team = teams.find(item => item.id === selected);
  const currentClient = useRef(client); currentClient.current = client;
  const generation = useRef(0), mutating = useRef(false);
  const refresh = async () => {
    if (mutating.current) return;
    const ticket = ++generation.current;
    const value = await client.list();
    if (currentClient.current === client && ticket === generation.current) { setTeams(value); setLoadError(''); }
  };
  useEffect(() => {
    setTeams([]); setSelected(saved(baseUrl)); setError(''); setLoadError(''); setPendingCreate(undefined); ++generation.current;
    if (!enabled) return;
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
    const active = !!team && enabled && visible; onModeChange(active);
    try { if (selected) conversationSessionStorage.setItem(`agent-remote:team:${baseUrl}`, selected); else conversationSessionStorage.removeItem(`agent-remote:team:${baseUrl}`); } catch { /* Keep navigation available without storage. */ }
  }, [team?.id, enabled, visible, selected, baseUrl, onModeChange]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
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
  }
  async function create() {
    if (!source) return;
    const input = pendingCreate ?? { operationId: crypto.randomUUID(), source }; setPendingCreate(input);
    const created = await client.create(input); if (currentClient.current !== client) return;
    setTeams(current => [...current.filter(value => value.id !== created.id), created]); setPendingCreate(undefined); setSelected(created.id); setOpen(false);
  }
  function groups(archived: boolean) {
    const items = teams.filter(team => (team.status === 'archived') === archived);
    const keys = [...new Set(items.map(team => JSON.stringify([team.source.hostId, team.source.providerId, team.source.nativeSessionId])))];
    return keys.map(key => { const group = items.filter(team => JSON.stringify([team.source.hostId, team.source.providerId, team.source.nativeSessionId]) === key), main = group[0]!.source;
      return <section key={key} className="lab-tpm-group"><header className="lab-tpm-group-heading"><h3>{main.title}</h3><small>{hosts.find(host => host.id === main.hostId)?.name ?? main.hostId}</small></header>
        <ul className="lab-tpm-list">{group.map(item => <TeamListItem key={item.id} team={item} selected={selected === item.id} busy={busy}
          onOpen={() => { setSelected(item.id); setOpen(false); }} onRename={title => run(() => change({action:'rename',teamId:item.id,title}))} />)}</ul></section>;
    });
  }
  if (!enabled) return null;
  return <>
    <div ref={root} data-hidden={!visible || undefined} aria-hidden={!visible || undefined} style={style} {...handlers} className="lab-tracking-floating lab-team-floating" onKeyDown={event => { handlers.onKeyDown?.(event); if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } }}>
      <button ref={trigger} className="lab-session-popover-trigger" aria-expanded={open} aria-label="Teams" onClick={() => { setOpen(!open); void refresh().catch(error => setError(errorMessage(error))); }}><span>Team</span><span>{teams.filter(item => item.status !== 'archived').length}</span></button>
      {open ? <section className="lab-session-popover-panel lab-tpm-panel" aria-label="Teams">
        <div className="lab-directory-heading"><h2>Teams</h2><button onClick={() => setOpen(false)} aria-label="Close Teams">×</button></div>
        {loading && !teams.length ? <p role="status">Loading teams…</p> : null}
        {groups(false)}
        {!teams.some(item => item.status !== 'archived') ? <p className="lab-control-note">Start with a Leader. Discuss the work, then add members.</p> : null}
        {teams.some(item => item.status === 'archived') ? <details><summary>Archived</summary>{groups(true)}</details> : null}
        <button type="button" disabled={busy || !source || !hosts.some(host => host.id === source.hostId && host.teamManagement && host.online)} onClick={() => void run(create)}>{pendingCreate ? 'Check previous creation' : 'New team'}</button>
        {!source || source.hostId === 'local' ? <p className="lab-control-note">Open a session on a connected Host to create a Team.</p> : null}
        {error || loadError ? <p role="alert">{error || loadError}</p> : null}
      </section> : null}
    </div>
    {team && mount ? createPortal(<TeamWorkspaceBody key={team.id} {...props} team={team} busy={busy} error={error || loadError} onExit={() => setSelected('')} onChange={input => run(() => change(input))} />, mount) : null}
  </>;
}

function TeamListItem({ team, selected, busy, onOpen, onRename }: {
  team: Team; selected: boolean; busy: boolean; onOpen(): void; onRename(title: string): Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false), [title, setTitle] = useState('');
  const renameButton = useRef<HTMLButtonElement>(null);
  function close() { setEditing(false); renameButton.current?.focus(); }
  return <li>
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
  </li>;
}

function TeamWorkspaceBody(props: Props & { team: Team; busy: boolean; error: string; onExit():void; onChange(input:TeamAction):Promise<boolean> }) {
  const { team, compact, hosts, busy, onChange } = props;
  const [current, setCurrent] = useState(team.members[0]!.id), [adding, setAdding] = useState(false);
  const [widths, setWidths] = useState<Record<string, number>>(() => { try { const value = JSON.parse(conversationSessionStorage.getItem(`agent-remote:team-widths:${props.baseUrl}:${team.id}`) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } });
  const widthsRef = useRef(widths); widthsRef.current = widths;
  function resize(id: string, width: number) { setWidths(current => ({ ...current, [id]: Math.max(320, Math.min(1400, width)) })); }
  function saveWidths() { try { conversationSessionStorage.setItem(`agent-remote:team-widths:${props.baseUrl}:${team.id}`, JSON.stringify(widthsRef.current)); } catch {} }
  const panes: Array<{ id:string; label:string; target:TeamSource; member?:TeamMember }> = [
    { id:'source', label:`Main · ${team.source.title}`, target:team.source },
    ...team.members.filter(member => member.creation !== 'abandoned').map(member => ({ id:member.id, label:member.role === 'leader' ? 'Leader' : member.name,
      target:{hostId:member.hostId,providerId:member.providerId,nativeSessionId:member.nativeSessionId ?? '',title:member.name}, member })),
  ];
  const activePane = panes.some(pane => pane.id === current) ? current : panes.find(pane => pane.member?.role === 'leader')?.id ?? 'source';
  return <section hidden={props.visible === false} className="lab-team-workspace" aria-label={`Team: ${team.title}`} data-compact={compact || undefined}>
    <header className="lab-team-heading"><div ref={props.viewTarget} className="lab-global-view-slot" /><strong className="lab-team-title" title={team.title}>{team.title}</strong>
      <button disabled={busy || team.status !== 'active'} onClick={() => setAdding(!adding)}>Add member</button>
      <button disabled={busy || team.status === 'archiving'} onClick={() => void onChange({teamId:team.id,action:team.status === 'archived' ? 'restore' : 'archive'})}>{team.status === 'archived' ? 'Restore' : team.status === 'archiving' ? 'Archiving…' : 'Archive'}</button>
      <button onClick={props.onExit} aria-label="Exit Team mode">Exit team</button>
    </header>

    {adding ? <AddTeamMember teamId={team.id} hosts={hosts.filter(host => host.teamManagement)} busy={busy} onChange={onChange} onClose={() => setAdding(false)} /> : null}
    {team.status === 'archiving' ? <p className="lab-control-note" role="status">New dispatches stopped. Waiting for members to settle. Open their sessions to resolve approvals or stop ongoing work.</p> : null}
    {props.error ? <p role="alert">{props.error}</p> : null}
    {team.messages.some(message => ['unknown', 'dispatching', 'rejected'].includes(message.status) || message.acceptance === 'queued') ? <details className="lab-team-recovery"><summary>Delivery status</summary>{team.messages.filter(message => ['unknown','dispatching','rejected'].includes(message.status) || message.acceptance === 'queued').map(message => <div key={message.id}><p>{message.status}: {message.text.slice(0,160)}</p><small>{message.error ?? 'Awaiting a native receipt. Do not repeat this message.'}</small>{message.status !== 'rejected' ? <><p>Inspect the receiving session before resolving.</p><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'resolve_message',messageId:message.id,outcome:'accepted'})}>Confirm received</button><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'resolve_message',messageId:message.id,outcome:'rejected'})}>Confirm not executed</button></> : null}</div>)}</details> : null}
    {compact ? <label className="lab-team-select">Session<select value={activePane} onChange={event => setCurrent(event.target.value)}>{panes.map(pane => <option key={pane.id} value={pane.id}>{pane.label}</option>)}</select></label> : null}
    <div className="lab-team-rail">{panes.map(pane => {
      const host = hosts.find(host => host.id === pane.target.hostId);
      return <TeamSessionFamily key={`${pane.id}:${sessionKey(pane.target)}`} id={pane.id} storageScope={`${props.baseUrl}:${team.id}`} baseUrl={props.baseUrl}
        target={pane.target} label={pane.label} hostLabel={host?.name ?? pane.target.hostId} offline={host?.online === false}
        compact={compact} active={!compact || activePane === pane.id} readOnly={pane.id !== 'source' && team.status === 'archived'}
        transport={props.transport} draftStore={props.draftStore} navigation={props.navigation} widths={widths} resize={resize} saveWidths={saveWidths}
        ready={!pane.member || pane.member.creation === 'ready'}
        header={pane.member?.responsibility ? <details className="lab-team-responsibility"><summary>Responsibility</summary>{pane.member.responsibility}{pane.member.cwd ? <p>{pane.member.cwd}</p> : null}{pane.member.summary ? <p>{pane.member.summary}</p> : null}</details> : null}
        unavailable={pane.member ? <div className="lab-control-note"><p>{pane.member.error ?? 'Session creation is pending.'}</p><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'retry_creation',memberId:pane.id})}>Check creation</button><button disabled={busy} onClick={() => void onChange({teamId:team.id,action:'abandon_creation',memberId:pane.id})}>Abandon slot</button></div> : null} />;
    })}</div>
  </section>;
}

function AddTeamMember({ teamId, hosts, busy, onChange, onClose }: {teamId:string;hosts:Host[];busy:boolean;onChange(input:TeamAction):Promise<boolean>;onClose():void}) {
  const [hostId,setHostId] = useState(hosts.find(host => host.online)?.id ?? ''), [providerId,setProviderId] = useState(''), [name,setName] = useState(''), [cwd,setCwd] = useState(''), [responsibility,setResponsibility] = useState('');
  const operation = useRef(crypto.randomUUID());
  const host = hosts.find(host => host.id === hostId), providers = host?.providers ?? [];
  const provider = providers.some(value => value.providerId === providerId) ? providerId : providers[0]?.providerId ?? '';
  return <form className="lab-team-form" onSubmit={event => {event.preventDefault(); void onChange({action:'add_member',teamId,operationId:operation.current,hostId,providerId:provider,name:name.trim() || host?.name || 'Member',cwd:cwd.trim(),responsibility}).then(ok => {if(ok)onClose();});}}>
    <label>Host<select disabled={busy} value={hostId} onChange={event => {setHostId(event.target.value); operation.current=crypto.randomUUID();}}>{hosts.map(host => <option key={host.id} value={host.id} disabled={!host.online}>{host.name}{!host.online ? ' · Offline' : ''}</option>)}</select></label>
    <label>Provider<select disabled={busy} value={provider} onChange={event => {setProviderId(event.target.value); operation.current=crypto.randomUUID();}}>{providers.map(provider => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}</select></label>
    <label>Name<input disabled={busy} maxLength={256} value={name} placeholder="Optional" onChange={event => setName(event.target.value)} /></label>
    <label>Working directory<input disabled={busy} maxLength={2048} value={cwd} placeholder="Host default directory" onChange={event => setCwd(event.target.value)} /></label>
    <label>Responsibility<textarea disabled={busy} maxLength={2048} value={responsibility} placeholder="Can be discussed with the Leader after joining" onChange={event => setResponsibility(event.target.value)} /></label>
    <div><button type="button" onClick={onClose}>Cancel</button><button disabled={busy || !host?.online || !provider}>Add member</button></div>
  </form>;
}
