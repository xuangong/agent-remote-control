import { useEffect, useRef, useState } from 'react';
import { RemoteTeamClient } from '@orchardworks/agent-remote-web/headless';
import { workspaceFetch } from '../workspace-access.js';
import { type SessionWindowEntry, type SessionWindowTarget } from '../hooks/useSessionWindows.js';
import { sessionKey } from '../session-tree.js';
import { teamLayoutTargets } from '../team-layout.js';

/** Team membership supplies targets; ordinary windows own their placement and lifetime. */
export function TeamGatherButton({ baseUrl, entry, onGather }: {
  baseUrl: string; entry: SessionWindowEntry; onGather(targets: SessionWindowTarget[]): void;
}) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const active = useRef(true), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function gather() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice('');
    try {
      const teams = await new RemoteTeamClient(baseUrl, workspaceFetch).list();
      if (!active.current) return;
      const team = teams.find(team => team.id === entry.groupId);
      if (!team) throw new Error('This Team is no longer available. Check the Team list.');
      const layout = teamLayoutTargets(team, false);
      if (!layout.groupRoot || !entry.target || sessionKey(layout.groupRoot) !== sessionKey(entry.target)) throw new Error('The Team Leader has changed. Reopen the Team from its list.');
      onGather(layout.dock);
      const unavailable = team.members.filter(member => member.creation !== 'abandoned' && (member.creation !== 'ready' || !member.nativeSessionId)).length;
      if (unavailable) setNotice(`${unavailable} member session(s) have no current execution locator. Check their status in the Team list.`);
    } catch (error) { if (active.current) setNotice(error instanceof Error ? error.message : 'Team members could not be loaded. Retry Gather.'); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <span className="lab-team-gather">
    <button type="button" disabled={busy} title="Open all current Team members" aria-label="Gather team members" onClick={() => void gather()}>{busy ? 'Gathering…' : 'Gather'}</button>
    {notice ? <span className="lab-team-gather-notice" role="alert">{notice}<button type="button" aria-label="Dismiss gather notice" onClick={() => setNotice('')}>×</button></span> : null}
  </span>;
}
