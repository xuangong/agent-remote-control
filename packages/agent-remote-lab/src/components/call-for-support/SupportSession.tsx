import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RemoteCallForSupportClient, type CallForSupportSettings, type RemoteTeamClient } from '@orchardworks/agent-remote-web/headless';
import { isCallForSupportCallInput, type CallForSupportCallInput, type CallForSupportDeliverable, type CallForSupportProfile, type Team, type TeamSource } from '@orchardworks/agent-remote-protocol';
import { workspaceFetch } from '../../workspace-access.js';
import './call-for-support.css';

const deliverables: Record<CallForSupportDeliverable, string> = { findings: 'Findings', answer: 'An answer', test_report: 'A test report', patch: 'A patch' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Call For Support is unavailable.';
const sameSession = (a: Pick<TeamSource, 'hostId' | 'providerId' | 'nativeSessionId'>, b: Pick<TeamSource, 'hostId' | 'providerId' | 'nativeSessionId'>) =>
  a.hostId === b.hostId && a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId;
/** The support groups that serve this session as their worker. */
/** The session's support roles that take calls; an archiving role takes none, and calling on its profile starts a new role. */
export const workerGroups = (teams: readonly Team[], source: TeamSource) => teams.filter(team => team.callForSupport && team.status === 'active'
  && team.members.some(member => member.role === 'requester' && member.nativeSessionId && sameSession({ ...member, nativeSessionId: member.nativeSessionId }, source)));
/** The profiles this session may call for: its own choice, or else the profiles enabled by default. */
export function enabledProfiles(settings: CallForSupportSettings, source: TeamSource): { profiles: CallForSupportProfile[]; explicit: boolean } {
  const entry = settings.enablement.find(item => sameSession(item, source));
  return entry ? { profiles: settings.profiles.filter(profile => entry.profileIds.includes(profile.id)), explicit: true } : { profiles: settings.profiles.filter(profile => profile.enableByDefault), explicit: false };
}

/** Call For Support for the session the Team panel is for: which profiles it may use, its open calls, and a call from the user. */
export function SupportSession({ baseUrl, source, teams, teamClient, busy, run, onTeam }: {
  baseUrl: string; source: TeamSource; teams: Team[]; teamClient: RemoteTeamClient; busy: boolean;
  run(action: () => Promise<void>): Promise<boolean>; onTeam(team: Team): void;
}) {
  const client = useMemo(() => new RemoteCallForSupportClient(baseUrl, workspaceFetch), [baseUrl]);
  const [settings, setSettings] = useState<CallForSupportSettings>(), [loadError, setLoadError] = useState('');
  const [choice, setChoice] = useState<string[]>(), [calling, setCalling] = useState(false);
  useEffect(() => {
    let stopped = false; setSettings(undefined); setChoice(undefined);
    void client.read().then(value => { if (!stopped) { setSettings(value); setLoadError(''); } }, error => { if (!stopped) setLoadError(errorMessage(error)); });
    return () => { stopped = true; };
  }, [client, source.hostId, source.providerId, source.nativeSessionId]);
  const groups = workerGroups(teams, source);
  if (loadError) return <section className="lab-support-session" aria-label="Call For Support"><h3>Call For Support</h3><p role="alert">{loadError}</p></section>;
  if (!settings) return null;
  const effective = enabledProfiles(settings, source), selected = choice ?? effective.profiles.map(profile => profile.id);
  const changed = choice !== undefined && JSON.stringify([...choice].sort()) !== JSON.stringify(effective.profiles.map(profile => profile.id).sort());
  return <section className="lab-support-session" aria-label="Call For Support">
    <h3>Call For Support</h3>
    {settings.profiles.length ? <>
      <div className="lab-support-inline" role="group" aria-label="Profiles this session may call for">{settings.profiles.map(profile => <label key={profile.id}>
        <input type="checkbox" disabled={busy} checked={selected.includes(profile.id)} onChange={event => setChoice(event.target.checked ? [...selected, profile.id] : selected.filter(id => id !== profile.id))} />{profile.name}</label>)}</div>
      <p className="lab-support-muted">{effective.explicit ? 'Chosen for this session.' : 'Following the profiles enabled by default.'} The session calls with its own tools; you can also call for it here.</p>
      {!effective.profiles.length && choice === undefined ? <p className="lab-control-note">Call For Support is available: choose the profiles this session may call for.</p> : null}
      {changed ? <div className="lab-support-actions"><button type="button" disabled={busy} onClick={() => void run(async () => {
        setSettings(await client.enable({ hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId, profileIds: selected })); setChoice(undefined);
      })}>Save for this session</button><button type="button" disabled={busy} onClick={() => setChoice(undefined)}>Discard</button></div> : null}
    </> : <p className="lab-control-note">Create a support profile in Settings to call for support.</p>}
    {groups.length ? <ul className="lab-support-profiles" aria-label="Support roles of this session">{groups.map(team => {
      const support = team.callForSupport!, open = support.calls.filter(call => call.status === 'open' || call.status === 'queued'), last = support.calls.filter(call => call.report).at(-1);
      return <li key={team.id}><div><strong>{support.role}</strong>
        <small>{open.length ? `${open.length} open ${open.length === 1 ? 'call' : 'calls'}` : 'No open calls'}{support.status === 'paused_budget' ? ' · paused' : ''}</small>
        {last ? <small>Last report: {last.report!.status} · {last.report!.summary.slice(0, 140)}</small> : null}</div></li>;
    })}</ul> : null}
    <div className="lab-support-actions"><button type="button" disabled={busy || !groups.length && !settings.profiles.length} onClick={() => setCalling(true)}>Call for support…</button></div>
    {calling ? <CallDialog source={source} groups={groups} profiles={settings.profiles} busy={busy}
      onSubmit={async request => run(async () => {
        if ('teamId' in request) onTeam(await teamClient.action({ action: 'call_for_support', ...request }));
        else onTeam(await teamClient.create(request));
      })} onClose={() => setCalling(false)} /> : null}
  </section>;
}

type CallRequest = { teamId: string; operationId: string; followUpOf?: string } & CallForSupportCallInput
  | { operationId: string; source: TeamSource; callForSupport: { profileId: string; call: CallForSupportCallInput; fresh?: boolean } };

function CallDialog({ source, groups, profiles, busy, onSubmit, onClose }: {
  source: TeamSource; groups: Team[]; profiles: CallForSupportProfile[]; busy: boolean; onSubmit(request: CallRequest): Promise<boolean>; onClose(): void;
}) {
  const [target, setTarget] = useState(groups[0] ? `role:${groups[0].id}` : profiles[0] ? `profile:${profiles[0].id}` : '');
  const [task, setTask] = useState(''), [deliverable, setDeliverable] = useState<CallForSupportDeliverable>('findings');
  const [commit, setCommit] = useState(''), [base, setBase] = useState(''), [files, setFiles] = useState(''), [conversation, setConversation] = useState(false);
  const [followUpOf, setFollowUpOf] = useState(''), [fresh, setFresh] = useState(false), [invalid, setInvalid] = useState(false);
  const operation = useRef<{ signature: string; id: string }>();
  const dialog = useRef<HTMLDialogElement>(null), label = useId();
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  const [kind, id] = target.split(/:(.*)/s) as ['role' | 'profile', string];
  const role = kind === 'role' ? groups.find(team => team.id === id) : undefined;
  const existing = kind === 'profile' && groups.some(team => team.callForSupport?.profileId === id);
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog lab-support-dialog" data-team-dialog aria-labelledby={label}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={label}>Call for support</h2><button type="button" aria-label="Close call" disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={event => {
      event.preventDefault();
      const context = { ...(commit.trim() ? { commit: commit.trim() } : {}), ...(base.trim() ? { base: base.trim() } : {}),
        ...(files.trim() ? { files: files.split('\n').map(file => file.trim()).filter(Boolean) } : {}), ...(conversation ? { conversation: true } : {}) };
      const call: CallForSupportCallInput = { task: task.trim(), deliverable, ...(Object.keys(context).length ? { context } : {}) };
      if (!target || !isCallForSupportCallInput(call)) { setInvalid(true); return; }
      const signature = JSON.stringify([target, call, followUpOf, fresh]);
      if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
      const request: CallRequest = kind === 'role' ? { teamId: id, operationId: operation.current.id, ...call, ...(followUpOf ? { followUpOf } : {}) }
        : { operationId: operation.current.id, source: structuredClone(source), callForSupport: { profileId: id, call, ...(fresh ? { fresh: true } : {}) } };
      void onSubmit(request).then(ok => { if (ok) onClose(); });
    }}>
      <p>For: <strong>{source.title}</strong></p>
      <label>Support<select disabled={busy} value={target} onChange={event => { setTarget(event.target.value); setFollowUpOf(''); setInvalid(false); }}>
        {groups.length ? <optgroup label="Roles of this session">{groups.map(team => <option key={team.id} value={`role:${team.id}`}>{team.callForSupport!.role}</option>)}</optgroup> : null}
        {profiles.length ? <optgroup label="New role from a profile">{profiles.map(profile => <option key={profile.id} value={`profile:${profile.id}`}>{profile.name}</option>)}</optgroup> : null}
      </select></label>
      {role?.callForSupport?.calls.length ? <label>Follow up on<select disabled={busy} value={followUpOf} onChange={event => setFollowUpOf(event.target.value)}>
        <option value="">A new question</option>
        {[...role.callForSupport.calls].reverse().map(call => <option key={call.id} value={call.id}>{call.status} · {call.task.slice(0, 60)}</option>)}
      </select></label> : null}
      {existing ? <div className="lab-support-inline"><label><input type="checkbox" disabled={busy} checked={fresh} onChange={event => setFresh(event.target.checked)} />Start fresh: archive this session's role for the profile</label></div> : null}
      <label>Task<textarea required disabled={busy} maxLength={12000} value={task} placeholder="What should the supporters do, and what does done look like?" onChange={event => { setTask(event.target.value); setInvalid(false); }} /></label>
      <label>Deliverable<select disabled={busy} value={deliverable} onChange={event => setDeliverable(event.target.value as CallForSupportDeliverable)}>
        {(Object.keys(deliverables) as CallForSupportDeliverable[]).map(value => <option key={value} value={value}>{deliverables[value]}</option>)}</select></label>
      <fieldset><legend>Context</legend>
        <div className="lab-support-row lab-support-host-row">
          <label>Commit<input disabled={busy} pattern="[0-9a-f]{7,64}" value={commit} placeholder="abc1234" onChange={event => setCommit(event.target.value)} /></label>
          <label>Base<input disabled={busy} pattern="[0-9a-f]{7,64}" value={base} placeholder="Optional" onChange={event => setBase(event.target.value)} /></label>
        </div>
        <label>Files<textarea disabled={busy} value={files} placeholder="One path per line" onChange={event => setFiles(event.target.value)} /></label>
        <div className="lab-support-inline"><label><input type="checkbox" disabled={busy} checked={conversation} onChange={event => setConversation(event.target.checked)} />The coordinator may read this conversation</label></div>
      </fieldset>
      {invalid ? <p role="alert">Describe the task (up to 12,000 characters), give commits as hexadecimal ids and at most 64 files.</p> : null}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="lab-favorite-primary" disabled={busy || !target}>Call</button></footer>
    </form>
  </dialog>, document.body);
}
