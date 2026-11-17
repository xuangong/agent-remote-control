import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { PortableTeamResourceStore, type TeamResourceStorage } from './team-resources.js';
function storage(): TeamResourceStorage {
  const rows = new Map<string, Uint8Array>();
  return { async get(key) { return rows.get(key)?.slice(); }, async put(key,value) { rows.set(key,value.slice()); }, async delete(key) { rows.delete(key); }, async list(prefix) { return [...rows.keys()].filter(key=>key.startsWith(prefix)); } };
}
const declaration = (bytes: Buffer, uploadId='upload') => ({uploadId,name:'fixture.zip',mediaType:'application/zip',byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
it('resumes bounded chunks after restart and verifies a file larger than Team text capacity', async () => {
  const disk=storage(), bytes=Buffer.alloc(200000,73), input=declaration(bytes);
  let store=new PortableTeamResourceStore({storage:disk});
  await store.begin('team',input);
  await store.chunk('team',{uploadId:input.uploadId,offset:0,contentBase64:bytes.subarray(0,32768).toString('base64')});
  store=new PortableTeamResourceStore({storage:disk});
  expect((await store.begin('team',input)).offset).toBe(32768);
  for(let offset=32768;offset<bytes.length;offset+=32768) await store.chunk('team',{uploadId:input.uploadId,offset,contentBase64:bytes.subarray(offset,offset+32768).toString('base64')});
  const result=await store.finish('team',input.uploadId);expect(result.resource?.sha256).toBe(input.sha256);
  expect(await store.finish('team',input.uploadId)).toEqual(result);
  const output:Buffer[]=[];for(let offset=0;offset<bytes.length;offset+=32768) output.push(Buffer.from((await store.readChunk('team',result.resource!.resourceId,offset)).contentBase64,'base64'));
  expect(Buffer.concat(output)).toEqual(bytes);
  await expect(store.getMetadata('other-team',result.resource!.resourceId)).rejects.toThrow('unavailable');
});
it('rejects changed upload identities, digest mismatch and store quota overflow', async () => {
  const store=new PortableTeamResourceStore({storage:storage(),quotaBytes:10}),bytes=Buffer.from('123');
  await store.begin('team',declaration(bytes));
  await expect(store.begin('team',{...declaration(bytes),name:'other'})).rejects.toThrow('identity');
  await store.chunk('team',{uploadId:'upload',offset:0,contentBase64:Buffer.from('321').toString('base64')});
  await expect(store.finish('team','upload')).rejects.toThrow('integrity');
  await expect(store.begin('team',declaration(Buffer.alloc(8),'other'))).rejects.toThrow('quota');
});
it('keeps pinned files while expiring unfinished uploads', async () => {
  let now=0;const disk=storage(),store=new PortableTeamResourceStore({storage:disk,draftTtlMs:10,now:()=>now,quotaBytes:6}),bytes=Buffer.from('abc');
  await store.begin('team',declaration(bytes));await store.chunk('team',{uploadId:'upload',offset:0,contentBase64:bytes.toString('base64')});
  const resource=(await store.finish('team','upload')).resource!;await store.pin('team',resource.resourceId);
  await store.begin('team',declaration(bytes,'pending'));now=11;
  await store.begin('team',declaration(bytes,'new'));expect(await store.getMetadata('team',resource.resourceId)).toEqual(resource);
});
it('keeps only the resources of listed Teams, deleting a removed Team\'s resources pinned or not', async () => {
  const disk=storage(), store=new PortableTeamResourceStore({storage:disk}), bytes=Buffer.from('bytes');
  const upload=async(scope:string,uploadId:string)=>{await store.begin(scope,declaration(bytes,uploadId));await store.chunk(scope,{uploadId,offset:0,contentBase64:bytes.toString('base64')});return (await store.finish(scope,uploadId)).resource!.resourceId;};
  const pinned=await upload('team:a','pinned'), draft=await upload('team:a','draft'), other=await upload('team:b','other');
  await store.pin('team:a',pinned);await store.begin('team:a',declaration(bytes,'partial'));
  await store.retain(() => ['team:b']);
  for(const id of [pinned,draft])await expect(store.getMetadata('team:a',id)).rejects.toThrow('unavailable');
  expect(await store.getMetadata('team:b',other)).toMatchObject({resourceId:other});
  // Only the other Team's manifest, chunk and index remain.
  expect(await disk.list('')).toHaveLength(3);
});
