import { expect, test } from 'vitest';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
const ref=(providerId:string)=>({controllerId:'controller',providerId,nativeSessionId:'same'});
const origin=ref('a'),current=ref('b'),reader={controllerId:'controller',providerId:'a',nativeSessionId:'side'};
const workspace={controllerId:'controller',canonicalCwd:'/workspace'};
const request={operationId:'succession',roleId:'role',expectedRevision:1,from:origin,targetProviderId:'b'};
const state:RemoteHostBrokerState={keys:[],hosts:[{id:'authenticated-host',installationId:'controller',name:'Host',legacyDsh:false,providers:[{providerId:'a',displayName:'A'},{providerId:'b',displayName:'B'}]}],bindings:[{hostId:'authenticated-host',providerId:'a',nativeSessionId:'same',agentId:'A'},{hostId:'authenticated-host',providerId:'b',nativeSessionId:'same',agentId:'B'},{hostId:'authenticated-host',providerId:'a',nativeSessionId:'side',agentId:'S',sourceRelation:{id:'side-relation',kind:'side',nativeSourceRef:origin,sourceNativeSessionId:'same',createdAt:'2026-10-10T00:00:00.000Z'}}],creations:[],associations:{version:4,relationResets:[],revision:5,admissions:[],relationChanges:[],freezes:[{hostId:'authenticated-host',released:'committed',receipt:{version:1,token:'freeze',authority:{version:1,origin:'https://relay.example',issuer:'issuer',namespace:'tenant',ownerSubject:'owner'},controllerId:'controller',request,associationRevision:0,lineage:[origin],relations:[{relationId:'side-relation',kind:'side',readerRef:reader,sourceRef:origin,linked:true,revision:0}]},projection:{version:1,role:{id:'role',origin,current,revision:2,workspace},receipt:{...request,phase:'committed',to:current,startedAt:'now',updatedAt:'now',committedRevision:2,prepared:{...request,to:current,workspace,associationRevision:1,participants:[],capture:{epoch:'e',seq:1,capturedAt:'now'}}}}}]}};
test('relation projection separates full immutable native source from current source and authenticated Host locator',()=>{
 const broker=createHostBroker({origin:'https://relay.example',ownerSubject:'owner',initialState:state});
 try{expect(broker.sessionRelations('owner')[0]).toMatchObject({nativeSourceRef:origin,source:{providerId:'b',nativeSessionId:'same',agentId:'B'},target:{providerId:'a',nativeSessionId:'side'},sourceBinding:{kind:'primary_role',roleId:'role',origin},hostLocator:{hostId:'authenticated-host',controllerId:'controller'}});expect(broker.sessionRelations('viewer')).toEqual([]);}finally{broker.close();}
});
test('unlinked projection returns original full source despite equal successor native ID strings',()=>{
 const changed=structuredClone(state);changed.bindings[2]!.sourceRelation!.linked=false;
 const broker=createHostBroker({origin:'https://relay.example',ownerSubject:'owner',initialState:changed});
 try{expect(broker.sessionRelations('owner')[0]).toMatchObject({source:{providerId:'a',agentId:'A'},sourceBinding:{kind:'fixed',source:origin},nativeSourceRef:origin});}finally{broker.close();}
});
