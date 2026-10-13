import { expect, it } from 'vitest';
import { fixture, send } from './fixture.js';

it('keeps Team membership and mailboxes owner-scoped and durable across a real Worker restart',async()=>{
 const f=await fixture(),alice=await f.login('alice'),bob=await f.login('bob');
 async function host(name:string){
  const {key}=await (await f.json(alice.basePath+'v1/remote/pairings',alice.cookie,{})).json() as {key:string};
  const h=await f.host(key,false,undefined,false,false,'codex',name,false,true);
  h.socket.addEventListener('message',event=>{const frame=JSON.parse(String(event.data));if(frame.type!=='rpc_request'||frame.path!=='/remote/team/create-seat')return;
    const seat=JSON.parse(frame.body);send(h.socket,{type:'rpc_response',requestId:frame.requestId,status:200,body:JSON.stringify({...seat.member,nativeSessionId:'native-'+seat.member.id,creation:'ready',activity:'idle'})});});
  return h;
 }
 const mac=await host('team-mac'),win=await host('team-win');
 const path=alice.basePath+'v1/remote/teams';
 const created=await f.json(path+'/create',alice.cookie,{operationId:'team-create',source:{hostId:mac.hostId,providerId:'codex',nativeSessionId:'main',title:'Project'}});
 expect(created.status).toBe(200);const team=await created.json() as any;
 const joined=await f.json(path+'/action',alice.cookie,{teamId:team.id,action:'add_member',operationId:'win',hostId:win.hostId,providerId:'codex',name:'Windows',cwd:'C:\\project',responsibility:'Verify'});
 expect(joined.status).toBe(200);expect((await joined.json() as any).members).toHaveLength(2);
 expect((await f.json(path,bob.cookie)).status).toBe(403);
 expect((await (await f.json(bob.basePath+'v1/remote/teams',bob.cookie)).json() as any).teams).toEqual([]);
 await f.restart();
 const restored=await f.json(path,alice.cookie);expect(restored.status).toBe(200);
 expect((await restored.json() as any).teams[0]).toMatchObject({id:team.id,members:[{role:'leader',creation:'ready'},{id:'win',role:'member',creation:'ready'}]});
},30000);
