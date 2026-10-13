import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
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
