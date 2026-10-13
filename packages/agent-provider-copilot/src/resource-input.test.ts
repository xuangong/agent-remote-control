import { expect, it } from 'vitest';
import { CopilotImages } from './images.js';
import { projectResourceInputText } from '@orchardworks/agent-provider-sdk';
it('uses a local resource reference even without image attachments',async()=>{
 const input=await new CopilotImages('s').input([{type:'resource',resourceId:'id',path:'/generated/fixture',name:'fixture.zip',mediaType:'application/zip',byteLength:0,sha256:'a'.repeat(64),label:'resource #1'}]);
 expect(input.attachments).toEqual([]); expect(projectResourceInputText(input.prompt)).toMatchObject([{type:'resource',locator:'input-resource:id'}]);
});
