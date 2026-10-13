import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
import { isTeamAction, isTeamCreate, isTeamHostCall } from './team.js';
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
