import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import type { TeamHostCall, TeamSeat } from '@orchardworks/agent-remote-protocol';

type CoordinatorCall = Extract<TeamHostCall, { action: 'propose_roster' | 'release_supporter' | 'report_support' | 'write_ledger' }>;
type Call = (input: CoordinatorCall extends infer T ? T extends unknown ? Omit<T, 'teamId' | 'memberId'> : never : never) => Promise<unknown>;
const id = { type: 'string', minLength: 1, maxLength: 256 };
const text = (maxLength: number, minLength = 0) => ({ type: 'string', ...(minLength ? { minLength } : {}), maxLength });
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, execute: (args: any) => Promise<unknown>): AgentSessionTool =>
  ({ name, description, inputSchema, execute: async args => JSON.stringify(await execute(args)) });

/** The coordinator organizes supporters within the mandate and answers each call with one report. */
export function coordinatorInstructions(seat: TeamSeat): string {
  const group = seat.callForSupport!;
  return [
    `You coordinate Call For Support for the role "${group.role}" in group ${seat.teamId}; you are member ${seat.member.id}.${group.description ? ` Role description: ${group.description}` : ''}`,
    'You serve one worker session. Calls arrive as messages from the worker\'s seat; read the group\'s calls, roster, mandate and ledger with read_team.',
    'For each call: decide what support it needs; if you need supporters, propose a roster with propose_roster and wait for their registration messages; release supporters you no longer need with release_supporter.',
    'Brief each supporter with only what it needs: the task, the commit, the files and how you will judge completion. Do not forward the worker\'s whole conversation.',
    'Supporters on the shared workspace must read code at the call\'s commit through git (git diff <base>..<commit>, git show <commit>:<path>), never the live working tree: the worker may keep working.',
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
    ? 'Your working directory is the worker\'s repository and it is read-only for you. Read code at the commit you are given through git (git show <commit>:<path>, git diff <base>..<commit>), not from the live files, which the worker may be changing.'
    : workspace ? `You work in your own worktree at commit ${workspace.commit}. You may change and commit there; the coordinator collects your changes as a patch. Never write anywhere else.` : '';
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
    tool('release_supporter', 'Release a supporter that is no longer needed. Its session is kept for history and receives nothing more.',
      object({ target: id }, ['target']), args => call({ action: 'release_supporter', target: args.target })),
    tool('report_support', 'Answer the open call with one report for the worker: status (reported, needs_input or failed), a summary, findings with severity, location, problem, suggestion, agreement and short evidence, and up to 8 uploaded resource IDs such as patches or logs. The report is delivered to the worker as advice. Reuse operationId to retry.',
      object({ callId: id, operationId: id, status: { type: 'string', enum: ['reported', 'needs_input', 'failed'] }, summary: text(4000, 1), findings: { type: 'array', items: finding, maxItems: 64 },
        resources: { type: 'array', items: id, minItems: 1, maxItems: 8, uniqueItems: true } }, ['callId', 'operationId', 'status', 'summary', 'findings']),
      args => call({ action: 'report_support', callId: args.callId, operationId: args.operationId,
        report: { status: args.status, summary: args.summary, findings: args.findings, ...(args.resources?.length ? { resources: args.resources } : {}) } })),
    tool('write_ledger', 'Replace your ledger: the durable state of this role, such as reviewed commits, findings and their status, and open questions. Pass the revision you read with read_team; a stale revision is refused.',
      object({ revision: { type: 'integer', minimum: 0 }, text: text(16000) }, ['revision', 'text']), args => call({ action: 'write_ledger', revision: args.revision, text: args.text })),
  ];
}
