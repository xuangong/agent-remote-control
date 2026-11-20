import { useEffect, useRef, useState } from 'react';
import { RemoteTeamClient } from '@orchardworks/agent-client';
import { workspaceFetch } from '../workspace-access.js';
import { type SessionWindowEntry, type SessionWindowTarget } from '../hooks/useSessionWindows.js';
import { sessionKey } from '../session-tree.js';
import { teamLayoutTargets } from '../team-layout.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { errorWords } from '../team-words.js';

/** Team membership supplies targets; ordinary windows own their placement and lifetime. */
export function TeamGatherButton({ baseUrl, entry, onGather }: {
  baseUrl: string; entry: SessionWindowEntry; onGather(targets: SessionWindowTarget[]): void;
}) {
  const t = useTranslate();
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
      if (!team) throw new Error(t('team.gather.teamGone'));
      const layout = teamLayoutTargets(team, false);
      // A handoff moves the Leader to another session, so the Leader is identified by its member ID.
      const leader = entry.teamMemberId ?? entry.target?.teamMemberId;
      if (!layout.groupRoot || !entry.target || (leader ? layout.groupRoot.teamMemberId !== leader : sessionKey(layout.groupRoot) !== sessionKey(entry.target))) throw new Error(t('team.gather.leaderChanged'));
      onGather(layout.dock);
      const unavailable = team.members.filter(member => member.creation !== 'abandoned' && member.creation !== 'released' && member.role !== 'requester' && (member.creation !== 'ready' || !member.nativeSessionId)).length;
      if (unavailable) setNotice(t('team.gather.unavailableMembers', { count: unavailable }));
    } catch (error) { if (active.current) setNotice(errorWords(t, error, 'team.gather.loadFailed')); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <span className="lab-team-gather">
    <button type="button" disabled={busy} title={t('team.gather.title')} aria-label={t('team.gather.label')} onClick={() => void gather()}>{busy ? t('team.gather.gathering') : t('team.gather.button')}</button>
    {notice ? <span className="lab-team-gather-notice" role="alert">{notice}<button type="button" aria-label={t('team.gather.dismiss')} onClick={() => setNotice('')}>×</button></span> : null}
  </span>;
}
