import { expect, it } from 'vitest';
import { resourceInputText, parseResourceInputText } from './resource-input.js';
it('round trips an attachment locator and displays generated local path without file content',()=>{
 const part={type:'resource' as const,path:'/store/generated.resource',resourceId:'stable',name:'test.zip',mediaType:'application/zip',byteLength:0,sha256:'a'.repeat(64),label:'resource #1'};
 expect(parseResourceInputText(resourceInputText(part))).toEqual({type:'resource',locator:'input-resource:stable',name:part.name,mediaType:part.mediaType,byteLength:0,sha256:part.sha256,label:part.label});
 expect(parseResourceInputText('unrelated user text')).toBeUndefined();
});
