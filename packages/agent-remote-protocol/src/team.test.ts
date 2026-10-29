import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { isTeam, isTeamAction, isTeamCreate, isTeamHostCall } from './team.js';
it('bounds explicit inbox acknowledgement and requires its exact recipient', () => {
  const call = { action: 'acknowledge', teamId: 'team', memberId: 'leader', messageIds: ['message'], expectedNativeSessionId: 'native' };
  expect(isTeamHostCall(call)).toBe(true);
  const envelope = { uplinkVersion: 2, type: 'team_request', requestId: 'ack', call };
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(envelope)).status).toBe('ok');
  for (const invalid of [{ ...call, messageIds: [] }, { ...call, messageIds: ['message', 'message'] },
    { ...call, messageIds: Array.from({ length: 33 }, (_, index) => String(index)) },
    { ...call, expectedNativeSessionId: undefined }, { ...call, expectedNativeSessionId: '' }, { ...call, force: true }]) {
    expect(isTeamHostCall(invalid)).toBe(false);
  }
});
it('admits only the bounded Team contract over the Host uplink',()=>{
  const call={action:'send',teamId:'team',memberId:'leader',to:'worker',operationId:'op',text:'Inspect logs'};
  expect(isTeamHostCall(call)).toBe(true);
  expect(isTeamHostCall({...call,command:'rm'})).toBe(false);
  expect(isTeamHostCall({...call,text:'a'.repeat(16001)})).toBe(false);
  const envelope={uplinkVersion:2 as const,type:'team_request' as const,requestId:'request',call:call as any};
  expect(encodeRemoteHostUplinkMessage(envelope).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(envelope)).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({uplinkVersion:2,type:'rpc_request',requestId:'create',method:'POST',path:'/remote/team/create-seat',body:'{}'})).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({uplinkVersion:2,type:'rpc_request',requestId:'create',method:'POST',path:'/remote/team/arbitrary-shell',body:'{}'})).status).toBe('rejected');
});
it('keeps membership creation in owner APIs rather than agent tools',()=>{
  expect(isTeamHostCall({action:'add_member',teamId:'team',memberId:'leader',hostId:'other'})).toBe(false);
  expect(isTeamCreate({operationId:'new',source:{hostId:'host',providerId:'codex',nativeSessionId:'source',title:'Main'}})).toBe(true);
  expect(isTeamAction({teamId:'team',action:'resolve_message',messageId:'message',outcome:'accepted'})).toBe(true);
});


it('validates exact recipient evidence additively and permits an unavailable public locator', () => {
  const resolvedTarget = { controllerId: 'controller', providerId: 'codex', nativeSessionId: 'B' };
  const claim = { action: 'claim', teamId: 'team', memberId: 'worker', messageId: 'message' };
  expect(isTeamHostCall(claim)).toBe(true);
  expect(isTeamHostCall({ ...claim, expectedNativeSessionId: 'B' })).toBe(true);
  expect(isTeamHostCall({ ...claim, expectedNativeSessionId: '' })).toBe(false);
  const settle = { ...claim, action: 'settle', outcome: 'unknown', resolvedTarget };
  expect(isTeamHostCall(settle)).toBe(true);
  expect(isTeamHostCall({ ...settle, resolvedTarget: { ...resolvedTarget, guessed: true } })).toBe(false);
  expect(isTeamHostCall({ ...settle, resolvedTarget: { ...resolvedTarget, nativeSessionId: 'x'.repeat(513) } })).toBe(false);
  const team = { id:'team',operationId:'create',revision:1,source:{hostId:'host',providerId:'codex',nativeSessionId:'source',title:'Source'},title:'Team',status:'active',members:[{id:'leader',hostId:'host',providerId:'codex',role:'leader',name:'Leader',responsibility:'',creation:'ready',activity:'unknown',summary:'',updatedAt:1}],messages:[],createdAt:1,updatedAt:1 };
  expect(isTeam(team)).toBe(true);
});


it('validates bounded unresolved compact evidence without inventing a message body', () => {
  const member = { hostId: 'host', providerId: 'codex', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 };
  const receipt = { id: 'legacy', from: 'leader', to: 'worker', status: 'accepted', createdAt: 1 };
  const team = { id: 'team', operationId: 'create', revision: 1, source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' }, title: 'Team', status: 'active',
    members: [{ ...member, id: 'leader', role: 'leader', name: 'Leader' }, { ...member, id: 'worker', role: 'member', name: 'Worker' }], messages: [], unresolvedReceipts: [receipt], createdAt: 1, updatedAt: 1 };
  expect(isTeam(team)).toBe(true);
  expect(isTeam({ ...team, unresolvedReceipts: [{ ...receipt, resolvedTarget: { controllerId: 'host', providerId: 'codex', nativeSessionId: 'A' } }] })).toBe(true);
  for (const extra of [{ text: 'Invented body' }, { fingerprint: 'a'.repeat(64) }, { acceptance: 'handled' }, { status: 'queued' }, { to: 'missing' }, { resolvedTarget: { controllerId: 'host', providerId: 'other', nativeSessionId: 'A' } }]) {
    expect(isTeam({ ...team, unresolvedReceipts: [{ ...receipt, ...extra }] })).toBe(false);
  }
  expect(isTeam({ ...team, unresolvedReceipts: [receipt, receipt] })).toBe(false);
  expect(isTeam({ ...team, messages: [{ ...receipt, text: 'Duplicate' }] })).toBe(false);
  expect(isTeam({ ...team, unresolvedReceipts: Array.from({ length: 201 }, (_, index) => ({ ...receipt, id: String(index) })) })).toBe(false);
});

const groupTeam = () => ({ id: 'team', operationId: 'op', revision: 1, source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'worker', title: 'Worker' }, title: 'Cross review', status: 'active',
  members: [
    { id: 'coordinator', hostId: 'mac', providerId: 'codex', role: 'leader', name: 'Coordinator', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1,
      nativeSessionId: 'coordinator-native', cwd: '/repo', model: 'gpt-5.5', access: 'read_only', workspace: { kind: 'shared' } },
    { id: 'requester', hostId: 'mac', providerId: 'codex', role: 'requester', name: 'Worker', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'worker', cwd: '/repo' },
    { id: 'reviewer', hostId: 'mac', providerId: 'claude', role: 'member', name: 'Reviewer', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1,
      nativeSessionId: 'reviewer-native', model: 'opus', reasoningEffort: 'max', access: 'read_only', workspace: { kind: 'shared' }, usage: { tokens: 10, updatedAt: 1 } },
    { id: 'tester', hostId: 'linux', providerId: 'codex', role: 'member', name: 'Tester', responsibility: '', creation: 'released', activity: 'idle', summary: '', updatedAt: 1,
      workspace: { kind: 'remote', commit: 'abcdef1', repository: '/srv/repo' } },
  ],
  messages: [{ id: 'call', from: 'requester', to: 'coordinator', text: 'Review.', status: 'queued', createdAt: 1, callForSupportCallId: 'c1' }],
  createdAt: 1, updatedAt: 1,
  callForSupport: { role: 'Cross review', description: '', mandate: { supporters: [{ providerId: 'claude', model: 'opus' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' },
    coordinator: { providerId: 'codex' }, status: 'active', calls: [{ id: 'c1', task: 'Review.', deliverable: 'findings', origin: 'worker', status: 'open', createdAt: 1, usage: { tokens: 0 } }],
    ledger: { text: '', revision: 0 }, usage: { tokens: 10 } },
});

it('accepts a Call For Support group with one requester after its coordinator', () => {
  expect(isTeam(groupTeam())).toBe(true);
});

it('keeps groups and ordinary Teams apart', () => {
  const plain = groupTeam() as any; delete plain.callForSupport;
  expect(isTeam(plain)).toBe(false);
  plain.members = plain.members.filter((member: any) => member.role !== 'requester').map(({ model: _m, reasoningEffort: _r, access: _a, workspace: _w, usage: _u, ...member }: any) => ({ ...member, creation: 'ready' }));
  plain.messages = [];
  expect(isTeam(plain)).toBe(true);
  expect(isTeam({ ...plain, messages: [{ id: 'm', from: plain.members[1].id, to: plain.members[0].id, text: 'Hi', status: 'queued', createdAt: 1, callForSupportCallId: 'c1' }] })).toBe(false);
  expect(isTeam({ ...plain, members: [plain.members[0], { ...plain.members[1], creation: 'released' }] })).toBe(false);
});

it('rejects groups that break their invariants', () => {
  const variants: Array<(team: any) => void> = [
    team => { team.members.splice(1, 1); },
    team => { team.members.push({ ...team.members[1], id: 'second-requester' }); },
    team => { team.members = [team.members[1], team.members[0], ...team.members.slice(2)]; },
    team => { delete team.members[2].access; },
    team => { team.members[2].hostId = 'linux'; },
    team => { team.messages[0].to = 'tester'; },
    team => { team.callForSupport.calls.push({ ...team.callForSupport.calls[0], id: 'c2' }); },
    team => { team.members[3].workspace = { kind: 'worktree', commit: 'HEAD' }; },
  ];
  for (const change of variants) { const team = groupTeam(); change(team); expect(isTeam(team)).toBe(false); }
});

it('admits Call For Support creation, actions and host calls', () => {
  const source = { hostId: 'mac', providerId: 'codex', nativeSessionId: 'worker', title: 'Worker' };
  expect(isTeamCreate({ operationId: 'op', source, callForSupport: { profileId: 'review', call: { task: 'Review.', deliverable: 'findings' } } })).toBe(true);
  expect(isTeamCreate({ operationId: 'op', source, callForSupport: { profileId: 'review', call: { task: 'x'.repeat(12001), deliverable: 'findings' } } })).toBe(false);
  for (const action of [{ teamId: 't', action: 'call_for_support', operationId: 'op', task: 'Again.', deliverable: 'findings', followUpOf: 'c1' },
    { teamId: 't', action: 'resolve_roster', rosterId: 'r', decision: 'reject', note: 'Too many.' }, { teamId: 't', action: 'release_member', memberId: 'm' },
    { teamId: 't', action: 'update_mandate', mandate: groupTeam().callForSupport.mandate, profileRevision: 2 }, { teamId: 't', action: 'resume_group' }]) {
    expect(isTeamAction(action)).toBe(true);
  }
  const seat = { teamId: 't', memberId: 'coordinator' };
  for (const call of [{ ...seat, action: 'propose_roster', operationId: 'op', members: [{ name: 'R', responsibility: '', providerId: 'claude', model: 'opus', workspace: 'shared' }], rationale: '' },
    { ...seat, action: 'report_support', callId: 'c1', operationId: 'op', report: { status: 'reported', summary: 'Done.', findings: [], resources: ['r1'] } },
    { ...seat, action: 'write_ledger', revision: 0, text: 'Reviewed abcdef1.' }, { ...seat, action: 'release_supporter', target: 'reviewer' },
    { ...seat, action: 'report_usage', tokens: 100, costUsd: 0.5 },
    { action: 'call_for_support', worker: { providerId: 'codex', nativeSessionId: 'worker' }, operationId: 'op', profileId: 'review', task: 'Review.', deliverable: 'findings', context: { commit: 'abcdef1' } },
    { action: 'support_status', worker: { providerId: 'codex', nativeSessionId: 'worker' }, roleId: 't' }]) {
    expect(isTeamHostCall(call)).toBe(true);
  }
  expect(isTeamHostCall({ ...seat, action: 'report_usage', tokens: -1 })).toBe(false);
  expect(isTeamHostCall({ ...seat, action: 'write_ledger', revision: 0, text: 'x'.repeat(16001) })).toBe(false);
});
