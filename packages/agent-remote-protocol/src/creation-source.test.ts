import { expect, test } from 'vitest';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage, isCreationSource } from './index.js';

test('creation provenance accepts only same-Host request identifiers without authority', () => {
  const source = { providerId:'codex', nativeSessionId:'native/session' };
  expect(isCreationSource(source)).toBe(true);
  for (const invalid of [null, [], {}, {...source,controllerId:'controller'}, {...source,hostId:'host'},
    {...source,providerId:''}, {...source,nativeSessionId:' native'}, {...source,nativeSessionId:'native\n'},
    {...source,nativeSessionId:'n'.repeat(257)}, {...source,providerId:1}]) expect(isCreationSource(invalid)).toBe(false);
}, 5000);

test('v2 uplink retains snapshot provenance as an opaque create body', () => {
  const body = '{ "providerId": "copilot", "creationSource": { "providerId": "codex", "nativeSessionId": "native/source" } }';
  const envelope = {uplinkVersion:2,type:'rpc_request',requestId:'snapshot-create',method:'POST',path:'/remote/create',sessionId:'projection',body} as const;
  expect(encodeRemoteHostUplinkMessage(envelope)).toEqual({status:'ok',json:JSON.stringify(envelope)});
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(envelope))).toEqual({status:'ok',value:envelope});
}, 5000);
