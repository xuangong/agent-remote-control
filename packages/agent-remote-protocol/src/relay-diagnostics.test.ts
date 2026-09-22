import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
it('admits only the exact Host diagnostic POST with a body and without a session',()=>{
 const base={uplinkVersion:2,type:'rpc_request',requestId:'r',method:'POST',path:'/remote/diagnostics/relay',body:'{"entries":[]}'};
 expect(decodeRemoteHostUplinkMessage(JSON.stringify(base)).status).toBe('ok');
 for(const frame of [{...base,method:'GET'},{...base,body:undefined},{...base,sessionId:'native'},{...base,path:base.path+'?key=secret'},{...base,path:base.path+'/extra'}]) expect(decodeRemoteHostUplinkMessage(JSON.stringify(frame)).status).toBe('rejected');
});
