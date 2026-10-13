import { expect, it } from 'vitest';
import { codexMessageInput } from './message-content.js';
import { parseResourceInputText } from '@orchardworks/agent-provider-sdk';
it('sends generic files as local references rather than native images',()=>{
 const input=codexMessageInput([{type:'resource',resourceId:'id',path:'/generated/fixture',name:'fixture.zip',mediaType:'application/zip',byteLength:0,sha256:'a'.repeat(64),label:'resource #1'}]);
 expect(input).toHaveLength(1);expect(input[0]?.type).toBe('text');if(input[0]?.type==='text') expect(parseResourceInputText(input[0].text)?.name).toBe('fixture.zip');
});
import { CodexEventProjector } from './projector.js';
it('projects native resource text back to a downloadable history part',()=>{
 const content=codexMessageInput([{type:'resource',resourceId:'id',path:'/generated/fixture',name:'fixture.zip',mediaType:'application/zip',byteLength:0,sha256:'a'.repeat(64),label:'resource #1'}]);
 const event=new CodexEventProjector('thread').projectNotification('item/completed',{threadId:'thread',turnId:'turn',item:{type:'userMessage',id:'message',content}});
 expect(event).toMatchObject({event:{item:{type:'user_message',text:'[resource #1]',content:[{type:'resource',locator:'input-resource:id',name:'fixture.zip'}]}}});
});
