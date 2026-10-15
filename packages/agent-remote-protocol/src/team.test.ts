import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { isTeam, isTeamAction, isTeamCreate, isTeamHostCall } from './team.js';
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
