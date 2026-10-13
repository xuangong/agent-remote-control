import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InputResourceStore } from './input-resource-store.js';
const dirs: string[] = [];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(options = {}) { const directory = await mkdtemp(join(tmpdir(),'resources-')); dirs.push(directory); return {directory,store:new InputResourceStore({directory,...options})}; }
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
describe('durable incoming resources',()=>{
 it('resumes binary uploads after restart, accepts duplicate chunks and isolates scopes',async()=>{
  const {directory,store}=await fixture(); const bytes=Buffer.from([0,255,1,2]); const declaration={uploadId:'u',name:'../fixture.zip',mediaType:'application/zip',byteLength:bytes.length,sha256:sha(bytes)};
  await store.begin('session',declaration); await store.chunk('session',{uploadId:'u',offset:0,contentBase64:bytes.subarray(0,2).toString('base64')});
  const restored=new InputResourceStore({directory}); expect((await restored.begin('session',declaration)).offset).toBe(2);
  await restored.chunk('session',{uploadId:'u',offset:0,contentBase64:bytes.subarray(0,2).toString('base64')});
  await restored.chunk('session',{uploadId:'u',offset:2,contentBase64:bytes.subarray(2).toString('base64')});
  const result=await restored.finish('session','u'); expect(result.resource?.sha256).toBe(sha(bytes));
  const id=result.resource!.resourceId;
  await expect(restored.getMetadata('other',id)).rejects.toThrow();
  expect((await restored.readChunk('session',id,0)).contentBase64).toBe(bytes.toString('base64'));
  const parts=await restored.resolveAndPin('session',[{type:'resource',resourceId:id,label:'resource #1'}]);
  expect(parts[0]?.type).toBe('resource'); if(parts[0]?.type==='resource') expect(await readFile(parts[0].path)).toEqual(bytes);
 });
 it('supports zero bytes, verifies digest, bounds quota and retains pinned resources',async()=>{
  let now=0;const {store}=await fixture({quotaBytes:4,draftTtlMs:10,now:()=>now});
  const empty={uploadId:'empty',name:'empty',mediaType:'application/octet-stream',byteLength:0,sha256:sha(Buffer.alloc(0))};
  await store.begin('s',empty); const id=(await store.finish('s','empty')).resource!.resourceId; await store.pin('s',id);
  await store.begin('s',{...empty,uploadId:'bad',byteLength:4}); await store.chunk('s',{uploadId:'bad',offset:0,contentBase64:Buffer.from('oops').toString('base64')});await expect(store.finish('s','bad')).rejects.toThrow(/digest/);
  await expect(store.begin('s',{...empty,uploadId:'overflow',byteLength:1})).rejects.toThrow(/quota/);
  now=11;expect((await store.getMetadata('s',id)).byteLength).toBe(0); expect((await store.readChunk('s',id,0)).contentBase64).toBe('');
  await store.begin('s',{...empty,uploadId:'replacement',byteLength:4});
 });
});
it('rejects conflicting retry bytes, oversize chunks and invalid offsets',async()=>{
 const {store}=await fixture();const bytes=Buffer.from('valid');const declaration={uploadId:'x',name:'x',mediaType:'application/octet-stream',byteLength:bytes.length,sha256:sha(bytes)};
 await store.begin('s',declaration);await store.chunk('s',{uploadId:'x',offset:0,contentBase64:bytes.toString('base64')});
 await expect(store.chunk('s',{uploadId:'x',offset:0,contentBase64:Buffer.from('other').toString('base64')})).rejects.toThrow(/conflicts/);
 await expect(store.chunk('s',{uploadId:'x',offset:0,contentBase64:Buffer.alloc(32769).toString('base64')})).rejects.toThrow();
 const resource=(await store.finish('s','x')).resource!; await expect(store.readChunk('s',resource.resourceId,6)).rejects.toThrow(/offset/);
 await expect(store.begin('s',{...declaration,name:'changed'})).rejects.toThrow(/conflicts/);
});
it('imports an explicit local file idempotently and preserves pinned data across restart',async()=>{
 const {directory,store}=await fixture(); const {writeFile}=await import('node:fs/promises');const source=join(directory,'source.zip');await writeFile(source,Buffer.from([0,255,42]));
 const resource=await store.importLocal('team',source,{uploadId:'id'});await store.pin('team',resource.resourceId);
 expect(await store.importLocal('team',source,{uploadId:'id'})).toEqual(resource);
 const restored=new InputResourceStore({directory,now:()=>Date.now()+1000000000});
 expect(await restored.getMetadata('team',resource.resourceId)).toEqual(resource);
});
