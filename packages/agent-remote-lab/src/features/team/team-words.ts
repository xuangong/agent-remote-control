import type { MessageKey, Translate } from '@orchardworks/agent-client';

/** The words of one value of a protocol enumeration; a value this build does not know is shown as it is. */
export function enumWords<Value extends string>(t: Translate, table: Readonly<Record<Value, MessageKey>>, value: Value): string {
  return table[value] ? t(table[value]) : value;
}

export const memberRoleWords = { leader: 'team.role.leader', member: 'team.role.member', requester: 'team.role.requester' } as const;
export const memberActivityWords = { unknown: 'team.activity.unknown', idle: 'team.activity.idle', busy: 'team.activity.busy' } as const;
export const memberCreationWords = { reserved: 'team.creation.reserved', ready: 'team.creation.ready', unknown: 'team.creation.unknown',
  abandoned: 'team.creation.abandoned', released: 'team.creation.released' } as const;
export const messageStatusWords = { queued: 'team.messageStatus.queued', dispatching: 'team.messageStatus.dispatching', accepted: 'team.messageStatus.accepted',
  rejected: 'team.messageStatus.rejected', unknown: 'team.messageStatus.unknown', canceled: 'team.messageStatus.canceled' } as const;
export const teamStatusWords = { active: 'team.status.active', archiving: 'team.status.archiving', archived: 'team.status.archived' } as const;
export const callStatusWords = { open: 'team.callStatus.open', queued: 'team.callStatus.queued', reported: 'team.callStatus.reported',
  needs_input: 'team.callStatus.needs_input', failed: 'team.callStatus.failed' } as const;
export const deliverableWords = { findings: 'team.deliverableRaw.findings', answer: 'team.deliverableRaw.answer', test_report: 'team.deliverableRaw.test_report',
  patch: 'team.deliverableRaw.patch' } as const;
export const rosterWorkspaceWords = { shared: 'team.group.rosterWorkspace.shared', worktree: 'team.group.rosterWorkspace.worktree', remote: 'team.group.rosterWorkspace.remote' } as const;
export const severityWords = { blocking: 'team.severity.blocking', major: 'team.severity.major', minor: 'team.severity.minor', note: 'team.severity.note' } as const;
