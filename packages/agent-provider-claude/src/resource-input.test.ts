import { expect, it } from 'vitest';
import { claudeMessageContent } from './message-content.js';
it('sends a generic resource as a reference without trying to decode it as an image',async()=>{
 const result=await claudeMessageContent([{type:'resource',resourceId:'id',path:'/generated/fixture',name:'fixture.zip',mediaType:'application/zip',byteLength:0,sha256:'a'.repeat(64),label:'resource #1'}]);
 expect(result).toMatchObject([{type:'text'}]);
});
import { ClaudeEventProjector } from './projector.js';
it('preserves the resource identifier in native history replay',async()=>{
 const content=await claudeMessageContent([{type:'resource',resourceId:'id',path:'/generated/fixture',name:'fixture.zip',mediaType:'application/zip',byteLength:0,sha256:'a'.repeat(64),label:'resource #1'}]);
 const events=new ClaudeEventProjector('thread','history').project({type:'user',session_id:'thread',uuid:'message',message:{content}});
 expect(events).toMatchObject([{event:{item:{type:'user_message',text:'[resource #1]',content:[{type:'resource',locator:'input-resource:id'}]}}}]);
});
