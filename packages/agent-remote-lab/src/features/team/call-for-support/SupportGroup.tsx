import { useState } from 'react';
import type { CallForSupportCall, CallForSupportMandate, Team, TeamAction, TeamSource } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { Translate } from '@orchardworks/agent-client';
import { callStatusWords, deliverableWords, enumWords, memberActivityWords, memberCreationWords, rosterWorkspaceWords, severityWords } from '../team-words.js';
import './call-for-support.css';

interface Host { id: string; name: string }
type Budget = NonNullable<CallForSupportMandate['budget']>;
const workspaceLabel = (t: Translate, member: Team['members'][number]) => member.workspace?.kind === 'shared' ? t('team.group.workspaceShared') : member.workspace?.kind === 'worktree' ? t('team.group.workspaceWorktree') : member.workspace?.kind === 'remote' ? t('team.group.workspaceRemote') : '';
const configuration = (value: { providerId: string; model?: string; reasoningEffort?: string }) => [value.providerId, value.model, value.reasoningEffort].filter(Boolean).join(' · ');
export const usageText = (usage: { tokens: number; costUsd?: number }, t: Translate) => `${t('team.support.tokens', { tokens: usage.tokens.toLocaleString('en-US') })}${usage.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(2)}` : ''}`;

/** A support group as the user sees it: what it is doing, what it used, and the decisions it waits for. */
export function SupportGroup({ team, hosts, busy, onChange, onDelete, onOpenSession }: {
  team: Team; hosts: Host[]; busy: boolean; onChange(input: TeamAction): Promise<boolean>; onDelete(): Promise<boolean>;
  onOpenSession(target: TeamSource & { teamId?: string; teamMemberId?: string }): void;
}) {
  const t = useTranslate();
  const support = team.callForSupport!, roster = support.roster;
  const [note, setNote] = useState(''), [budget, setBudget] = useState<Budget>(support.mandate.budget ?? {}), [deleting, setDeleting] = useState(false);
  const hostName = (id: string) => hosts.find(host => host.id === id)?.name ?? id;
  const supporters = team.members.filter(member => member.role === 'member');
  const worker = team.members.find(member => member.role === 'requester'), coordinator = team.members.find(member => member.role === 'leader');
  const name = (id: string) => team.members.find(member => member.id === id)?.name ?? id;
  // Deliveries whose outcome is uncertain hold the group until the user says what happened.
  const uncertain = [...team.messages.filter(message => message.status === 'unknown'), ...(team.unresolvedReceipts ?? [])];
  return <section className="lab-support-group" aria-label={t('team.group.roleLabel', { role: support.role })}>
    <p className="lab-support-muted">{support.description || t('team.group.defaultDescription')} · {usageText(support.usage, t)}</p>
    {support.status === 'paused_budget' ? <div className="lab-support-card" data-attention>
      <h4>{t('team.group.pausedBudget')}</h4><p>{support.pauseReason}</p>
      <div className="lab-support-row lab-support-host-row">
        {(['tokensPerCall', 'tokensTotal', 'costUsdTotal'] as const).map(key => <label key={key}>{key === 'tokensPerCall' ? t('team.profile.tokensPerCall') : key === 'tokensTotal' ? t('team.profile.tokensTotal') : t('team.profile.costUsd')}
          <input type="number" min={key === 'costUsdTotal' ? 0 : 1} step={key === 'costUsdTotal' ? '0.01' : '1'} disabled={busy} value={budget[key] ?? ''} placeholder={t('team.profile.noLimit')}
            onChange={event => setBudget(current => ({ ...current, [key]: event.target.value ? Number(event.target.value) : undefined }))} /></label>)}
      </div>
      <div className="lab-support-actions"><button type="button" disabled={busy} onClick={() => void (async () => {
        const limits = Object.fromEntries(Object.entries(budget).filter(([, value]) => value !== undefined)) as Budget;
        const { budget: _previous, ...mandate } = support.mandate;
        if (await onChange({ teamId: team.id, action: 'update_mandate', mandate: { ...mandate, ...(Object.keys(limits).length ? { budget: limits } : {}) } })) await onChange({ teamId: team.id, action: 'resume_group' });
      })()}>{t('team.group.raiseBudget')}</button></div>
    </div> : null}
    {roster?.status === 'pending' ? <div className="lab-support-card" data-attention aria-label={t('team.group.rosterProposal')}>
      <h4>{t('team.group.rosterProposal')} <span className="lab-support-badge" data-tone={roster.withinMandate ? undefined : 'warning'}>{roster.withinMandate ? t('team.group.withinProfile') : t('team.group.outsideProfile')}</span></h4>
      <ul>{roster.members.map((member, index) => <li key={index}><strong>{member.name}</strong> · {configuration(member)} · {enumWords(t, rosterWorkspaceWords, member.workspace)}{member.hostId ? t('team.group.onHost', { host: hostName(member.hostId) }) : ''}<br /><span className="lab-support-muted">{member.responsibility}</span></li>)}</ul>
      {roster.release?.length ? <p>{t('team.group.releases', { names: roster.release.map(id => team.members.find(member => member.id === id)?.name ?? id).join(', ') })}</p> : null}
      {roster.rationale ? <p>{roster.rationale}</p> : null}
      <label>{t('team.group.noteToCoordinator')}<input disabled={busy} maxLength={2048} value={note} placeholder={t('team.team.optional')} onChange={event => setNote(event.target.value)} /></label>
      <div className="lab-support-actions">
        <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'resolve_roster', rosterId: roster.id, decision: 'approve', ...(note.trim() ? { note: note.trim() } : {}) })}>{t('team.group.approve')}</button>
        <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'resolve_roster', rosterId: roster.id, decision: 'reject', ...(note.trim() ? { note: note.trim() } : {}) })}>{t('team.group.reject')}</button>
      </div>
    </div> : null}
    {uncertain.length ? <div className="lab-support-card" data-attention aria-label={t('team.group.uncertainDeliveries')}>
      <h4>{t('team.group.deliveriesToCheck')}</h4>
      {uncertain.map(message => <div key={message.id}>
        <p>{name(message.from)} → {name(message.to)}: {'text' in message ? message.text.slice(0, 160) : t('team.group.bodyGone')}</p>
        <p className="lab-support-muted">{message.error ?? t('team.group.openReceiver')}</p>
        <div className="lab-support-actions">
          <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'resolve_message', messageId: message.id, outcome: 'accepted' })}>{t('team.group.confirmReceived')}</button>
          <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'resolve_message', messageId: message.id, outcome: 'rejected' })}>{t('team.group.confirmNotReceived')}</button>
        </div>
      </div>)}
    </div> : null}
    {support.calls.length ? <details open={support.calls.some(call => call.status === 'open')}><summary>{t('team.group.calls', { count: support.calls.length })}</summary>
      {[...support.calls].reverse().map(call => <SupportCall key={call.id} call={call} t={t} />)}</details> : null}
    {/* Released supporters stay listed: their sessions remain open for reading. */}
    {supporters.length ? <details open><summary>{t('team.group.supporters', { count: supporters.length, active: supporters.filter(member => member.creation !== 'released' && member.creation !== 'abandoned').length })}</summary>
      <ul className="lab-team-members">{supporters.map(member => <li key={member.id}>
        <button type="button" disabled={busy || member.creation !== 'ready' && member.creation !== 'released' || !member.nativeSessionId}
          onClick={() => onOpenSession({ teamId: team.id, teamMemberId: member.id, hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId!, title: member.name })}>{member.name}</button>
        <small>{configuration({ providerId: member.providerId, ...(member.model ? { model: member.model } : {}), ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}) })} · {workspaceLabel(t, member)} · {hostName(member.hostId)} · {member.creation === 'ready' ? enumWords(t, memberActivityWords, member.activity) : enumWords(t, memberCreationWords, member.creation)}{member.usage ? ` · ${usageText(member.usage, t)}` : ''}</small>
        {member.creation === 'ready' ? <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'release_member', memberId: member.id })}>{t('team.group.release')}</button> : null}
        {member.error && member.creation !== 'ready' ? <div><p>{member.error}</p></div> : null}
      </li>)}</ul></details> : null}
    {team.status === 'archived' ? <p className="lab-support-muted">{t('team.group.archivedNote')}</p> : null}
    <div className="lab-support-actions">
      {worker?.nativeSessionId ? <button type="button" disabled={busy} onClick={() => onOpenSession(team.source)}>{t('team.group.openWorker')}</button> : null}
      {coordinator?.nativeSessionId ? <button type="button" disabled={busy || coordinator.creation !== 'ready'}
        onClick={() => onOpenSession({ teamId: team.id, teamMemberId: coordinator.id, hostId: coordinator.hostId, providerId: coordinator.providerId, nativeSessionId: coordinator.nativeSessionId!, title: coordinator.name })}>{t('team.group.openCoordinator')}</button> : null}
      {/* Restoring resumes the worker's seat and the coordinator; supporters stay released. */}
      <button type="button" disabled={busy || team.status === 'archiving'} onClick={() => void onChange({ teamId: team.id, action: team.status === 'archived' ? 'restore' : 'archive' })}>{team.status === 'archived' ? t('team.team.restore') : team.status === 'archiving' ? t('team.team.archiving') : t('team.team.archive')}</button>
      {team.status !== 'archived' ? null : deleting
        ? <><button type="button" disabled={busy} onClick={() => void onDelete()}>{t('team.group.confirmDeletion')}</button><button type="button" disabled={busy} onClick={() => setDeleting(false)}>{t('team.support.keep')}</button></>
        : <button type="button" disabled={busy} onClick={() => setDeleting(true)}>{t('common.delete')}</button>}
    </div>
  </section>;
}

function SupportCall({ call, t }: { call: CallForSupportCall; t: Translate }) {
  const report = call.report;
  return <div className="lab-support-card" aria-label={t('team.group.callNamed', { id: call.id })}>
    <p><span className="lab-support-badge" data-tone={call.status === 'needs_input' || call.status === 'failed' ? 'warning' : undefined}>{enumWords(t, callStatusWords, call.status)}</span> {call.origin === 'worker' ? t('team.group.fromWorker') : t('team.group.fromYou')} · {enumWords(t, deliverableWords, call.deliverable)} · {usageText(call.usage, t)}</p>
    <p>{call.task.length > 400 ? `${call.task.slice(0, 399)}…` : call.task}</p>
    {report ? <>
      <p><strong>{t('team.group.report')}</strong> {report.summary}</p>
      {report.findings.length ? <ul className="lab-support-findings">{report.findings.map(finding => <li key={finding.id}>
        <strong>{enumWords(t, severityWords, finding.severity)}</strong>{finding.location ? ` · ${finding.location}` : ''}: {finding.problem}{finding.suggestion ? ` → ${finding.suggestion}` : ''}{finding.agreement ? ` (${finding.agreement})` : ''}
      </li>)}</ul> : null}
      {report.resources?.length ? <p>{t('team.group.resources', { names: report.resources.map(resource => resource.name).join(', ') })}</p> : null}
      {report.compacted ? <p className="lab-support-muted">{t('team.group.trimmed')}</p> : null}
    </> : null}
  </div>;
}
