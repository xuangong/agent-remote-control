import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { isTeam, isTeamAction, isTeamCreate, isTeamDelete, isTeamHostCall } from './team.js';
it('admits only the bounded Team contract over the Host uplink',()=>{
  const call={action:'claim',teamId:'team',memberId:'worker',messageId:'message'};
  expect(isTeamHostCall(call)).toBe(true);
  expect(isTeamHostCall({...call,command:'rm'})).toBe(false);
  expect(isTeamHostCall({...call,messageId:''})).toBe(false);
  const envelope={uplinkVersion:2 as const,type:'team_request' as const,requestId:'request',call:call as any};
  expect(encodeRemoteHostUplinkMessage(envelope).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(envelope)).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({uplinkVersion:2,type:'rpc_request',requestId:'create',method:'POST',path:'/remote/team/create-seat',body:'{}'})).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({uplinkVersion:2,type:'rpc_request',requestId:'create',method:'POST',path:'/remote/team/arbitrary-shell',body:'{}'})).status).toBe('rejected');
});
it('has no ordinary Team to make, change or message: a Team is made only to start a bot',()=>{
  for (const call of [{action:'add_member',teamId:'team',memberId:'leader',hostId:'other'},{action:'send',teamId:'team',memberId:'leader',to:'worker',operationId:'op',text:'Hi'},
    {action:'acknowledge',teamId:'team',memberId:'leader',messageIds:['m'],expectedNativeSessionId:'n'},{action:'describe_member',teamId:'team',memberId:'leader',target:'w',responsibility:'x'},
    {action:'report',teamId:'team',memberId:'leader',summary:'x'}]) expect(isTeamHostCall(call)).toBe(false);
  const source={hostId:'host',providerId:'codex',nativeSessionId:'source',title:'Main'};
  expect(isTeamCreate({operationId:'new',source})).toBe(false);
  expect(isTeamCreate({operationId:'new',source,bot:{name:'Review',mission:'Review the change.'}})).toBe(true);
  for (const action of [{action:'resolve_message',messageId:'message',outcome:'accepted'},{action:'archive'},{action:'restore'},{action:'rename',title:'x'},{action:'abandon_creation',memberId:'m'},
    {action:'retry_creation',memberId:'m'},{action:'add_member',operationId:'o',hostId:'h',providerId:'p',cwd:'',name:'n',responsibility:''}]) expect(isTeamAction({teamId:'team',...action})).toBe(false);
  expect(isTeamAction({teamId:'team',action:'keep_task'})).toBe(true);
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
  const team = { id:'team',operationId:'create',revision:1,source:{hostId:'host',providerId:'codex',nativeSessionId:'source',title:'Source'},title:'Team',status:'active',members:[{id:'leader',hostId:'host',providerId:'codex',role:'leader',name:'Leader',responsibility:'',creation:'ready',activity:'unknown',summary:'',updatedAt:1}],messages:[],createdAt:1,updatedAt:1,inbox:{botId:'b_'+'0'.repeat(32)} };
  expect(isTeam(team)).toBe(true);
});


it('validates bounded unresolved compact evidence without inventing a message body', () => {
  const member = { hostId: 'host', providerId: 'codex', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 };
  const receipt = { id: 'legacy', from: 'leader', to: 'worker', status: 'accepted', createdAt: 1 };
  const team = { id: 'team', operationId: 'create', revision: 1, source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' }, title: 'Team', status: 'active',
    members: [{ ...member, id: 'leader', role: 'requester', name: 'Leader' }, { ...member, id: 'worker', role: 'requester', name: 'Worker' }], messages: [], unresolvedReceipts: [receipt], createdAt: 1, updatedAt: 1,
    link: { assistants: ['leader', 'worker'], recent: [] } };
  expect(isTeam(team)).toBe(true);
  expect(isTeam({ ...team, unresolvedReceipts: [{ ...receipt, resolvedTarget: { controllerId: 'host', providerId: 'codex', nativeSessionId: 'A' } }] })).toBe(true);
  for (const extra of [{ text: 'Invented body' }, { fingerprint: 'a'.repeat(64) }, { acceptance: 'handled' }, { status: 'queued' }, { to: 'missing' }, { resolvedTarget: { controllerId: 'host', providerId: 'other', nativeSessionId: 'A' } }]) {
    expect(isTeam({ ...team, unresolvedReceipts: [{ ...receipt, ...extra }] })).toBe(false);
  }
  expect(isTeam({ ...team, unresolvedReceipts: [receipt, receipt] })).toBe(false);
  expect(isTeam({ ...team, messages: [{ ...receipt, text: 'Duplicate' }] })).toBe(false);
  expect(isTeam({ ...team, unresolvedReceipts: Array.from({ length: 201 }, (_, index) => ({ ...receipt, id: String(index) })) })).toBe(false);
});

const ordinaryTeam = () => ({ id: 'team', operationId: 'op', revision: 1, source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'worker', title: 'Worker' }, title: 'Cross review', status: 'active',
  members: [
    { id: 'coordinator', hostId: 'mac', providerId: 'codex', role: 'leader', name: 'Coordinator', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'coordinator-native' },
    { id: 'reviewer', hostId: 'mac', providerId: 'claude', role: 'member', name: 'Reviewer', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'reviewer-native' },
  ],
  messages: [], createdAt: 1, updatedAt: 1 });

it('accepts no ordinary Team: a Team is a task, a link, a bot\'s inbox or a room', () => {
  expect(isTeam(ordinaryTeam())).toBe(false);
  expect(isTeam({ ...ordinaryTeam(), link: { assistants: ['coordinator', 'reviewer'], recent: [] } })).toBe(false);
});
