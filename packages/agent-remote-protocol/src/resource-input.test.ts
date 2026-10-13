import { describe, expect, it } from 'vitest';
import { decodeClientMessage, decodeServerMessage, PROTOCOL_VERSION } from './index.js';
const declaration = { requestId: 'r', agentId: 'a', uploadId: 'u', name: 'fixture.zip', mediaType: 'application/zip', byteLength: 0, sha256: 'a'.repeat(64) };
describe('resource input protocol', () => {
  it('accepts zero-byte resources and structured resource message references', () => {
    expect(decodeClientMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'resource_upload_begin', payload: declaration })).status).toBe('ok');
    expect(decodeClientMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'send_message', payload: { requestId:'r',operationId:'019c6e27-e55b-73d1-87d8-4e01f1f75043',agentId: 'a', content: [{type:'resource',resourceId:'id',label:'[resource #1]'}] } })).status).toBe('ok');
  });
  it('accepts an empty final download chunk', () => {
    expect(decodeServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION,type:'resource_download_result',payload:{requestId:'r',agentId:'a',resourceId:'id',offset:0,contentBase64:'',name:'empty',mediaType:'application/octet-stream',byteLength:0,sha256:'a'.repeat(64)}})).status).toBe('ok');
  });
});
it('requires the resource-aware protocol before sending strict resource capabilities',()=>{
  expect(PROTOCOL_VERSION).toBe('1.8.0');
  expect(decodeClientMessage(JSON.stringify({protocolVersion:'1.7.0',type:'negotiate'})).status).toBe('rejected');
});
