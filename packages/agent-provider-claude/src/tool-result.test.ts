import {expect,it} from 'vitest';
import {claudeFileChanges} from './tool-result.js';

it('uses actual native created content when the new-file patch is empty',()=>{
 expect(claudeFileChanges('Write',{type:'create',filePath:'/a.txt',structuredPatch:[],content:'actual'})).toEqual({format:'file_changes',version:1,files:[{path:'/a.txt',kind:'added',diff:'--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+actual\n\\ No newline at end of file\n'}]});
 expect(claudeFileChanges('Write',{type:'update',filePath:'/a.txt',structuredPatch:[],content:'actual'})).toBeUndefined();
});
it.each([undefined,{}, {filePath:'/a',structuredPatch:[{oldStart:1,oldLines:10,newStart:1,newLines:1,lines:['-old','+new']}]},
 {filePath:'/a',structuredPatch:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-old','+new\n+injected']}]},
 {filePath:'/a',structuredPatch:'not a patch'}])('leaves malformed or unavailable native output unmapped: %j',result=>{
 expect(claudeFileChanges('Edit',result)).toBeUndefined();
});
