import { useState } from 'react';
import type { CallForSupportCall, CallForSupportMandate, Team, TeamAction, TeamSource } from '@orchardworks/agent-remote-protocol';
import './call-for-support.css';

interface Host { id: string; name: string }
type Budget = NonNullable<CallForSupportMandate['budget']>;
const workspaceLabel = (member: Team['members'][number]) => member.workspace?.kind === 'shared' ? 'shared, read-only' : member.workspace?.kind === 'worktree' ? 'own worktree' : member.workspace?.kind === 'remote' ? 'remote worktree' : '';
const configuration = (value: { providerId: string; model?: string; reasoningEffort?: string }) => [value.providerId, value.model, value.reasoningEffort].filter(Boolean).join(' · ');
export const usageText = (usage: { tokens: number; costUsd?: number }) => `${usage.tokens.toLocaleString('en-US')} tokens${usage.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(2)}` : ''}`;

/** A support group as the user sees it: what it is doing, what it used, and the decisions it waits for. */
export function SupportGroup({ team, hosts, busy, onChange, onOpenSession }: {
  team: Team; hosts: Host[]; busy: boolean; onChange(input: TeamAction): Promise<boolean>; onOpenSession(target: TeamSource & { teamId?: string; teamMemberId?: string }): void;
}) {
  const support = team.callForSupport!, roster = support.roster;
  const [note, setNote] = useState(''), [budget, setBudget] = useState<Budget>(support.mandate.budget ?? {});
  const hostName = (id: string) => hosts.find(host => host.id === id)?.name ?? id;
  const supporters = team.members.filter(member => member.role === 'member');
  const worker = team.members.find(member => member.role === 'requester');
  const name = (id: string) => team.members.find(member => member.id === id)?.name ?? id;
  // Deliveries whose outcome is uncertain hold the group until the user says what happened.
  const uncertain = [...team.messages.filter(message => message.status === 'unknown'), ...(team.unresolvedReceipts ?? [])];
  return <section className="lab-support-group" aria-label={`Support role ${support.role}`}>
    <p className="lab-support-muted">{support.description || 'Support for this session.'} · {usageText(support.usage)}</p>
    {support.status === 'paused_budget' ? <div className="lab-support-card" data-attention>
      <h4>Paused: budget reached</h4><p>{support.pauseReason}</p>
      <div className="lab-support-row lab-support-host-row">
        {(['tokensPerCall', 'tokensTotal', 'costUsdTotal'] as const).map(key => <label key={key}>{key === 'tokensPerCall' ? 'Tokens per call' : key === 'tokensTotal' ? 'Tokens in total' : 'Cost in USD'}
          <input type="number" min={key === 'costUsdTotal' ? 0 : 1} step={key === 'costUsdTotal' ? '0.01' : '1'} disabled={busy} value={budget[key] ?? ''} placeholder="No limit"
            onChange={event => setBudget(current => ({ ...current, [key]: event.target.value ? Number(event.target.value) : undefined }))} /></label>)}
      </div>
      <div className="lab-support-actions"><button type="button" disabled={busy} onClick={() => void (async () => {
        const limits = Object.fromEntries(Object.entries(budget).filter(([, value]) => value !== undefined)) as Budget;
        const { budget: _previous, ...mandate } = support.mandate;
        if (await onChange({ teamId: team.id, action: 'update_mandate', mandate: { ...mandate, ...(Object.keys(limits).length ? { budget: limits } : {}) } })) await onChange({ teamId: team.id, action: 'resume_group' });
      })()}>Raise budget and resume</button></div>
    </div> : null}
    {roster?.status === 'pending' ? <div className="lab-support-card" data-attention aria-label="Roster proposal">
      <h4>Roster proposal <span className="lab-support-badge" data-tone={roster.withinMandate ? undefined : 'warning'}>{roster.withinMandate ? 'Within the profile' : 'Outside the profile'}</span></h4>
      <ul>{roster.members.map((member, index) => <li key={index}><strong>{member.name}</strong> · {configuration(member)} · {member.workspace}{member.hostId ? ` on ${hostName(member.hostId)}` : ''}<br /><span className="lab-support-muted">{member.responsibility}</span></li>)}</ul>
      {roster.release?.length ? <p>Releases: {roster.release.map(id => team.members.find(member => member.id === id)?.name ?? id).join(', ')}</p> : null}
      {roster.rationale ? <p>{roster.rationale}</p> : null}
      <label>Note to the coordinator<input disabled={busy} maxLength={2048} value={note} placeholder="Optional" onChange={event => setNote(event.target.value)} /></label>
      <div className="lab-support-actions">
        <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'resolve_roster', rosterId: roster.id, decision: 'approve', ...(note.trim() ? { note: note.trim() } : {}) })}>Approve</button>
        <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'resolve_roster', rosterId: roster.id, decision: 'reject', ...(note.trim() ? { note: note.trim() } : {}) })}>Reject</button>
      </div>
    </div> : null}
    {uncertain.length ? <div className="lab-support-card" data-attention aria-label="Uncertain deliveries">
      <h4>Deliveries to check</h4>
      {uncertain.map(message => <div key={message.id}>
        <p>{name(message.from)} → {name(message.to)}: {'text' in message ? message.text.slice(0, 160) : 'The message body is no longer available.'}</p>
        <p className="lab-support-muted">{message.error ?? 'Open the receiving session to check before deciding.'}</p>
        <div className="lab-support-actions">
          <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'resolve_message', messageId: message.id, outcome: 'accepted' })}>Confirm received</button>
          <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'resolve_message', messageId: message.id, outcome: 'rejected' })}>Confirm not received</button>
        </div>
      </div>)}
    </div> : null}
    {support.calls.length ? <details open={support.calls.some(call => call.status === 'open')}><summary>Calls ({support.calls.length})</summary>
      {[...support.calls].reverse().map(call => <SupportCall key={call.id} call={call} />)}</details> : null}
    {supporters.length ? <details><summary>Supporters ({supporters.filter(member => member.creation !== 'released' && member.creation !== 'abandoned').length} active)</summary>
      <ul className="lab-team-members">{supporters.map(member => <li key={member.id}>
        <button type="button" disabled={busy || member.creation !== 'ready' && member.creation !== 'released' || !member.nativeSessionId}
          onClick={() => onOpenSession({ teamId: team.id, teamMemberId: member.id, hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId!, title: member.name })}>{member.name}</button>
        <small>{configuration({ providerId: member.providerId, ...(member.model ? { model: member.model } : {}), ...(member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {}) })} · {workspaceLabel(member)} · {hostName(member.hostId)} · {member.creation === 'ready' ? member.activity : member.creation}{member.usage ? ` · ${usageText(member.usage)}` : ''}</small>
        {member.creation === 'ready' ? <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'release_member', memberId: member.id })}>Release</button> : null}
        {member.error && member.creation !== 'ready' ? <div><p>{member.error}</p></div> : null}
      </li>)}</ul></details> : null}
    <div className="lab-support-actions">
      {worker?.nativeSessionId ? <button type="button" disabled={busy} onClick={() => onOpenSession(team.source)}>Open worker session</button> : null}
      {/* An archived group is history: calling for support again starts a new group. */}
      {team.status === 'archived' ? <span>Archived</span>
        : <button type="button" disabled={busy || team.status === 'archiving'} onClick={() => void onChange({ teamId: team.id, action: 'archive' })}>{team.status === 'archiving' ? 'Archiving…' : 'Archive'}</button>}
    </div>
  </section>;
}

function SupportCall({ call }: { call: CallForSupportCall }) {
  const report = call.report;
  return <div className="lab-support-card" aria-label={`Call ${call.id}`}>
    <p><span className="lab-support-badge" data-tone={call.status === 'needs_input' || call.status === 'failed' ? 'warning' : undefined}>{call.status.replace('_', ' ')}</span> {call.origin === 'worker' ? 'From the worker' : 'From you'} · {call.deliverable.replace('_', ' ')} · {usageText(call.usage)}</p>
    <p>{call.task.length > 400 ? `${call.task.slice(0, 399)}…` : call.task}</p>
    {report ? <>
      <p><strong>Report:</strong> {report.summary}</p>
      {report.findings.length ? <ul className="lab-support-findings">{report.findings.map(finding => <li key={finding.id}>
        <strong>{finding.severity}</strong>{finding.location ? ` · ${finding.location}` : ''}: {finding.problem}{finding.suggestion ? ` → ${finding.suggestion}` : ''}{finding.agreement ? ` (${finding.agreement})` : ''}
      </li>)}</ul> : null}
      {report.resources?.length ? <p>Resources: {report.resources.map(resource => resource.name).join(', ')}</p> : null}
      {report.compacted ? <p className="lab-support-muted">Older details were trimmed to keep this role within its storage.</p> : null}
    </> : null}
  </div>;
}
