import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect,it } from 'vitest';
import { TeamResourceFiles } from './team-resource-files.js';
import { PortableTeamResourceStore } from '../../agent-remote-hosted/src/team-resources.js';
it('uploads and downloads original bytes without overwriting a conflicting local file',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-resource-')),rows=new Map<string,Uint8Array>();
  const store=new PortableTeamResourceStore({storage:{async get(key){return rows.get(key);},async put(key,value){rows.set(key,value);},async delete(key){rows.delete(key);},async list(prefix){return [...rows.keys()].filter(key=>key.startsWith(prefix));}}});
  let loseChunkReceipt=false;
  const request=async(call:any)=>{
    if(call.action==='resource_begin')return store.begin('team',{...call,uploadId:call.operationId});
    if(call.action==='resource_chunk'){const receipt=await store.chunk('team',{...call,uploadId:call.operationId});if(loseChunkReceipt){loseChunkReceipt=false;throw new Error('Connection closed after chunk persistence');}return receipt;}
    if(call.action==='resource_finish')return store.finish('team',call.operationId);
    if(call.action==='resource_metadata')return store.getMetadata('team',call.resourceId);
    return store.readChunk('team',call.resourceId,call.offset);
  };
  try{
    const bytes=Buffer.alloc(200000,99),path=join(root,'fixture.zip');await writeFile(path,bytes);
    const files=new TeamResourceFiles(root,request),resource=await files.upload('team','sender',path,'upload');
    expect(resource.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    loseChunkReceipt=true;await expect(files.upload('team','sender',path,'resume')).rejects.toThrow('Connection closed');
    expect(await files.upload('team','sender',path,'resume')).toMatchObject({sha256:resource.sha256,byteLength:bytes.length});
    const downloaded=await files.download('team','recipient',resource.resourceId);
    expect(await readFile(downloaded.localPath)).toEqual(bytes);
    expect((await files.download('team','recipient',resource.resourceId)).localPath).toBe(downloaded.localPath);
    await writeFile(downloaded.localPath,'local changes');
    await expect(files.download('team','recipient',resource.resourceId)).rejects.toThrow('existing');
    expect(await readFile(downloaded.localPath,'utf8')).toBe('local changes');
  }finally{await rm(root,{recursive:true,force:true});}
});

it.skipIf(process.platform==='win32')('rejects a FIFO without waiting for a writer',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-resource-fifo-')),path=join(root,'fixture.fifo');
  const execute=promisify(execFile);
  try{
    await execute('mkfifo',[path],{timeout:2000});
    const output=ts.transpileModule(await readFile(new URL('./team-resource-files.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    const modulePath=join(root,'resource-files.mjs');await writeFile(modulePath,output);
    await symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),join(root,'node_modules'));
    const source=pathToFileURL(modulePath).href;
    const script=`import {TeamResourceFiles} from ${JSON.stringify(source)};const files=new TeamResourceFiles(${JSON.stringify(root)},async()=>{throw new Error('Transport must not run');});try{await files.upload('team','sender',${JSON.stringify(path)},'fifo');process.exitCode=1;}catch(error){process.stdout.write(error.message);}`;
    const result=await execute(process.execPath,['--input-type=module','-e',script],{timeout:2000});
    expect(result.stdout).toContain('regular file');
  }finally{await rm(root,{recursive:true,force:true});}
},5000);

it.each(['upload', 'download'] as const)('stops a %s when its attachment retires between resource RPCs', async direction => {
  const root = await mkdtemp(join(tmpdir(), 'team-resource-retired-'));
  const bytes = Buffer.alloc(70000, 42), path = join(root, 'input.bin');
  const metadata = { resourceId: 'resource', name: 'input.bin', mediaType: 'application/octet-stream', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let current = true; const calls: string[] = [];
  const files = new TeamResourceFiles(root, async call => {
    calls.push(call.action);
    if (call.action === 'resource_begin') return { offset: 0 };
    if (call.action === 'resource_metadata') return metadata;
    current = false;
    if (call.action === 'resource_chunk') return { offset: Math.min(bytes.length, call.offset + 32768) };
    if (call.action === 'resource_finish') return { offset: bytes.length, resource: metadata };
    if (call.action === 'resource_read') return { ...metadata, offset: call.offset, contentBase64: bytes.subarray(call.offset, call.offset + 32768).toString('base64') };
    throw new Error('Unexpected resource call');
  });
  const guard = () => { if (!current) throw new Error('Attachment retired'); };
  try {
    await writeFile(path, bytes);
    await expect(direction === 'upload' ? files.upload('team', 'member', path, 'operation', guard)
      : files.download('team', 'member', 'resource', undefined, guard)).rejects.toThrow('Attachment retired');
    expect(calls).toEqual(direction === 'upload' ? ['resource_begin', 'resource_chunk'] : ['resource_metadata', 'resource_read']);
  } finally { await rm(root, { recursive: true, force: true }); }
});


it('does not publish the final local download if the attachment retires during the last RPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-resource-final-')), bytes = Buffer.from('last chunk');
  const metadata = { resourceId: 'resource', name: 'input.bin', mediaType: 'application/octet-stream', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let current = true;
  const files = new TeamResourceFiles(root, async call => {
    if (call.action === 'resource_metadata') return metadata;
    current = false; return { ...metadata, offset: 0, contentBase64: bytes.toString('base64') };
  });
  try {
    await expect(files.download('team', 'member', 'resource', root, () => { if (!current) throw new Error('Retired'); })).rejects.toThrow('Retired');
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
