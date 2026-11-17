import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import type { TeamHostCall, TeamSeat } from '@orchardworks/agent-remote-protocol';

type CoordinatorCall = Extract<TeamHostCall, { action: 'propose_roster' | 'release_supporter' | 'report_support' | 'write_ledger' | 'collect_supporter_patch' }>;
type Call = (input: CoordinatorCall extends infer T ? T extends unknown ? Omit<T, 'teamId' | 'memberId'> : never : never) => Promise<unknown>;
const id = { type: 'string', minLength: 1, maxLength: 256 };
const text = (maxLength: number, minLength = 0) => ({ type: 'string', ...(minLength ? { minLength } : {}), maxLength });
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, execute: (args: any) => Promise<unknown>): AgentSessionTool =>
  ({ name, description, inputSchema, execute: async args => JSON.stringify(await execute(args)) });

/** Where the worker's files are, which the coordinator and shared supporters read in place. */
const workerFiles = (cwd: string | undefined) => cwd ? `the worker's working directory, ${cwd}` : 'the worker\'s working directory';

/**
 * Where a Team member is, and what that means for files: members on one Host share its file system and read each other's
 * files in place; only members on other Hosts need transfers.
 */
export function locationInstructions(seat: TeamSeat): string {
  return [
    `You are on Host ${seat.member.hostId}${seat.member.cwd ? `, working in ${seat.member.cwd}` : ''}.`,
    'read_team lists every member with its hostId and working directory (cwd); onYourHost marks the members on your Host.',
    'Members on your Host share its file system: read their files in place, within your permissions, instead of asking for snapshots, copies or uploads.',
    'Transfer files only to or from members on other Hosts, whose paths do not exist here.',
  ].join(' ');
}

/** The coordinator organizes supporters within the mandate and answers each call with one report. */
export function coordinatorInstructions(seat: TeamSeat): string {
  const group = seat.callForSupport!;
  return [
    `You coordinate Call For Support for the role "${group.role}" in group ${seat.teamId}; you are member ${seat.member.id}.${group.description ? ` Role description: ${group.description}` : ''}`,
    'You serve one worker session. Calls arrive as messages from the worker\'s seat; read the group\'s calls, roster, mandate and ledger with read_team.',
    `You run on the worker's Host, in ${workerFiles(seat.member.cwd)}, read-only. Supporters on the shared workspace run there too. You and they read the worker's files in place, including uncommitted and untracked changes, and other directories of this Host the call points to, such as a worktree of the repository.`,
    'Review what the call names: the code at its commit through git when it gives one, otherwise the files as they are. Never ask the worker for a snapshot commit, a patch or a copy of what you can read yourself; note in the report the HEAD and the state you reviewed (for example git status), since the worker may keep working. Ask the worker for a commit only when a worktree or remote supporter needs one.',
    'For each call: decide what support it needs; if you need supporters, propose a roster with propose_roster and wait for their registration messages. Prefer shared supporters when reading is enough.',
    'Keep supporters across calls: an idle supporter costs nothing, since its runtime is released and its session resumes with its context on your next brief, and follow-ups are what that context is for. Do not release a supporter because its part of a call is done. Release one with release_supporter only when the role no longer needs it, or to make room within the mandate.',
    'A worktree supporter is on your Host too: read its worktree in place to review its work, and collect its patch with collect_supporter_patch to hand the change to the worker, since the worktree is removed with its supporter. A remote supporter is on another Host: it starts from a bundle of the call\'s commit, and its changes reach you only as a patch or resources.',
    'Brief each supporter with only what it needs: the task, where to read (the directory, or the commit), the files and how you will judge completion. Do not forward the worker\'s whole conversation.',
    'Read the worker\'s conversation with read_source_session only when the call says you may.',
    'Collect evidence, merge duplicates, and mark agreement and disagreement. Answer every call with exactly one report_support. Use needs_input when you need the worker or the user, and failed when the support cannot be given.',
    'The report is advice for the worker: say what matters and why, with locations and suggestions. Do not name supporters, models or hosts unless the worker needs to know.',
    'Keep your durable state with write_ledger: reviewed commits, findings and their status, open questions. Read it before each call, so you can continue after compaction or a handoff.',
    'Never edit the worker\'s workspace, and never ask a supporter to. Code a supporter writes stays in its own worktree.',
    'Await responses instead of sending the same brief again. Native permissions still apply.',
  ].join(' ');
}

/** A supporter works on its brief and reports evidence to the coordinator only. */
export function supporterInstructions(seat: TeamSeat): string {
  const workspace = seat.member.workspace;
  const where = workspace?.kind === 'shared'
    ? `You run on the worker's Host, in ${workerFiles(seat.member.cwd)}, read-only, next to the worker and your coordinator. Read the files in place, including uncommitted and untracked changes, or the code at a commit through git when your brief names one. Never ask for a snapshot, a patch or a copy of what you can read yourself; say which state you read, since the worker may keep working.`
    : workspace?.kind === 'worktree' ? `You work in your own worktree at commit ${workspace.commit}, on the worker's Host. You may change and commit there; the coordinator reads it in place and collects your changes as a patch. You may read the worker's files in place, but never write anywhere else.`
    : workspace ? `You work in your own worktree at commit ${workspace.commit}, on another Host than the worker and your coordinator: the commit came as a bundle, and their paths do not exist here. You may change and commit there; the coordinator collects your changes as a patch. Never write anywhere else.` : '';
  return [
    `You support the role "${seat.callForSupport!.role}" in Call For Support group ${seat.teamId}; you are member ${seat.member.id}.`,
    'Your coordinator briefs you through Team messages. Read read_team to find your brief and your coordinator.',
    where,
    'Work only on the brief. Send findings, evidence and questions to the coordinator with send_team_message; attach long material as resources. You do not talk to the worker or the user.',
    'Do not delegate or change your authority. Native permissions still apply.',
  ].filter(Boolean).join(' ');
}

const finding = object({ id: text(64, 1), severity: { type: 'string', enum: ['blocking', 'major', 'minor', 'note'] }, location: text(2048), problem: text(4000, 1),
  suggestion: text(4000), agreement: text(256), evidence: text(4000) }, ['id', 'severity', 'problem']);
const rosterMember = object({ name: text(256, 1), responsibility: text(2048), providerId: id, model: text(256, 1), reasoningEffort: text(64, 1),
  workspace: { type: 'string', enum: ['shared', 'worktree', 'remote'] }, hostId: id }, ['name', 'responsibility', 'providerId', 'model', 'workspace']);

/** Tools only the coordinator has. */
export function coordinatorTools(call: Call): AgentSessionTool[] {
  return [
    tool('propose_roster', 'Propose the supporters this role needs now: provider, model and effort from the mandate, and a workspace (shared reads the worker\'s repository read-only; worktree and remote get their own worktree at the call\'s commit; remote needs hostId). Optionally release supporters first. The Relay checks the mandate: a roster within it may start at once, others wait for the user. Reuse operationId to retry.',
      object({ operationId: id, members: { type: 'array', items: rosterMember, minItems: 1, maxItems: 6 }, release: { type: 'array', items: id, maxItems: 12, uniqueItems: true }, rationale: text(4000) }, ['operationId', 'members', 'rationale']),
      args => call({ action: 'propose_roster', operationId: args.operationId, members: args.members, ...(args.release?.length ? { release: args.release } : {}), rationale: args.rationale })),
    tool('release_supporter', 'Release a supporter the role no longer needs, or to make room within the mandate. It receives nothing more; its session stays for the user to read. Do not release a supporter only because a call is done: an idle supporter costs nothing and keeps its context for follow-ups.',
      object({ target: id }, ['target']), args => call({ action: 'release_supporter', target: args.target })),
    tool('report_support', 'Answer the open call with one report for the worker: status (reported, needs_input or failed), a summary, findings with severity, location, problem, suggestion, agreement and short evidence, and up to 8 uploaded resource IDs such as patches or logs. The report is delivered to the worker as advice. Reuse operationId to retry.',
      object({ callId: id, operationId: id, status: { type: 'string', enum: ['reported', 'needs_input', 'failed'] }, summary: text(4000, 1), findings: { type: 'array', items: finding, maxItems: 64 },
        resources: { type: 'array', items: id, minItems: 1, maxItems: 8, uniqueItems: true } }, ['callId', 'operationId', 'status', 'summary', 'findings']),
      args => call({ action: 'report_support', callId: args.callId, operationId: args.operationId,
        report: { status: args.status, summary: args.summary, findings: args.findings, ...(args.resources?.length ? { resources: args.resources } : {}) } })),
    tool('collect_supporter_patch', 'Collect everything a worktree or remote supporter changed in its own worktree since the call\'s commit, as one patch resource you may read. Review it, then attach its resourceId to report_support for the worker to apply itself. Collect before releasing the supporter. Reuse operationId to retry.',
      object({ target: id, operationId: id }, ['target', 'operationId']), args => call({ action: 'collect_supporter_patch', target: args.target, operationId: args.operationId })),
    tool('write_ledger', 'Replace your ledger: the durable state of this role, such as reviewed commits, findings and their status, and open questions. Pass the revision you read with read_team; a stale revision is refused.',
      object({ revision: { type: 'integer', minimum: 0 }, text: text(16000) }, ['revision', 'text']), args => call({ action: 'write_ledger', revision: args.revision, text: args.text })),
  ];
}
