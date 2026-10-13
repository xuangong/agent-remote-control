import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, link, unlink, lstat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { isTeamResource, type TeamHostCall, type TeamResource } from '@orchardworks/agent-remote-protocol';

const CHUNK_BYTES=32768;
const resource = (value:unknown):TeamResource => {if(!isTeamResource(value))throw new Error('Invalid Team resource metadata.');return value;};
const uploadReceipt = (value:unknown,length:number):{offset:number;resource?:TeamResource} => {
  if(!value||typeof value!=='object'||!('offset' in value)||!Number.isSafeInteger(value.offset)||Number(value.offset)<0||Number(value.offset)>length||Number(value.offset)!==length&&Number(value.offset)%CHUNK_BYTES!==0)throw new Error('Invalid resource upload receipt.');
  return {offset:Number(value.offset),...('resource' in value&&value.resource?{resource:resource(value.resource)}:{})};
};
async function digestFile(path:string):Promise<{sha256:string;byteLength:number}>{
  const file=await open(path,constants.O_RDONLY | constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||stat.size>50*1024*1024)throw new Error('Resource must be a regular file no larger than 50 MiB.');
    const digest=createHash('sha256'),buffer=Buffer.alloc(CHUNK_BYTES);let offset=0;
    while(offset<stat.size){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!bytesRead)throw new Error('Resource changed while reading.');digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
    return {sha256:digest.digest('hex'),byteLength:stat.size};
  }finally{await file.close();}
}

/** Explicit local file transfer tools. Downloading never executes the received file. */
export class TeamResourceFiles {
  constructor(private readonly directory:string,private readonly request:(call:TeamHostCall)=>Promise<unknown>){}
  async upload(teamId:string,memberId:string,path:string,operationId:string):Promise<TeamResource>{
    if(!isAbsolute(path))throw new Error('Upload requires an absolute path on this Host.');
    const {sha256,byteLength}=await digestFile(path),scope={teamId,memberId,operationId};
    let receipt=uploadReceipt(await this.request({...scope,action:'resource_begin',name:basename(path),mediaType:'application/octet-stream',byteLength,sha256}),byteLength);
    if(receipt.resource){const result=uploadReceipt(await this.request({...scope,action:'resource_finish'}),byteLength).resource;if(!result||result.sha256!==sha256||result.byteLength!==byteLength)throw new Error('Resource upload integrity verification failed.');return result;}
    const file=await open(path,constants.O_RDONLY | constants.O_NONBLOCK);try{
      const stat=await file.stat();if(!stat.isFile())throw new Error('Resource must be a regular file.');if(stat.size!==byteLength)throw new Error('Resource changed before upload.');
      const buffer=Buffer.alloc(CHUNK_BYTES);
      while(receipt.offset<byteLength){const offset=receipt.offset,expected=Math.min(buffer.length,byteLength-offset),{bytesRead}=await file.read(buffer,0,expected,offset);if(bytesRead!==expected)throw new Error('Resource changed during upload.');
        receipt=uploadReceipt(await this.request({...scope,action:'resource_chunk',offset,contentBase64:buffer.subarray(0,bytesRead).toString('base64')}),byteLength);
        if(receipt.offset<=offset)throw new Error('Resource upload made no progress.');
      }
    }finally{await file.close();}
    const result=uploadReceipt(await this.request({...scope,action:'resource_finish'}),byteLength).resource;
    if(!result||result.sha256!==sha256||result.byteLength!==byteLength)throw new Error('Resource upload integrity verification failed.');return result;
  }
  async download(teamId:string,memberId:string,resourceId:string,outputDirectory?:string):Promise<TeamResource & {localPath:string;verified:true}>{
    if(outputDirectory!==undefined&&!isAbsolute(outputDirectory))throw new Error('Download directory must be an absolute path on this Host.');
    const scope={teamId,memberId,resourceId},metadata=resource(await this.request({...scope,action:'resource_metadata'}));
    if(metadata.resourceId!==resourceId)throw new Error('Resource identity mismatch.');
    const key=createHash('sha256').update(JSON.stringify([teamId,memberId,resourceId])).digest('hex');
    const directory=outputDirectory??join(this.directory,'downloads',key);
    await mkdir(directory,{recursive:true,mode:0o700});
    const name=metadata.name.split(/[\\/]/).at(-1)!.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100)||'resource';
    const target=join(directory,`${key.slice(0,16)}-${name}`);
    const existing=async()=>{
      try{if(!(await lstat(target)).isFile())throw new Error('The existing destination is not a regular file.');const actual=await digestFile(target);if(actual.sha256!==metadata.sha256||actual.byteLength!==metadata.byteLength)throw new Error('The existing destination contains different bytes.');return true;}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
    };
    if(await existing())return {...metadata,localPath:target,verified:true};
    const temp=join(directory,`.resource-${randomUUID()}.part`),file=await open(temp,'wx',0o600),digest=createHash('sha256');let offset=0;
    try{
      while(offset<metadata.byteLength){const value=await this.request({...scope,action:'resource_read',offset});
        if(!value||typeof value!=='object'||!('contentBase64' in value)||typeof value.contentBase64!=='string'||!('offset' in value)||value.offset!==offset)throw new Error('Invalid resource download chunk.');
        const chunkMetadata=resource(Object.fromEntries(['resourceId','name','mediaType','byteLength','sha256'].map(key=>[key,(value as Record<string,unknown>)[key]])));
        if((['resourceId','name','mediaType','byteLength','sha256'] as const).some(key=>chunkMetadata[key]!==metadata[key]))throw new Error('Resource metadata changed during download.');
        const bytes=Buffer.from(value.contentBase64,'base64');
        if(!bytes.length||bytes.length>CHUNK_BYTES||bytes.toString('base64')!==value.contentBase64||offset+bytes.length>metadata.byteLength)throw new Error('Invalid resource download bytes.');
        await file.writeFile(bytes);digest.update(bytes);offset+=bytes.length;
      }
      if(offset!==metadata.byteLength||digest.digest('hex')!==metadata.sha256)throw new Error('Resource download integrity verification failed.');
      await file.sync();await file.close();
      try{await link(temp,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!await existing())throw error;}
      return {...metadata,localPath:target,verified:true};
    }finally{await file.close().catch(()=>undefined);await unlink(temp).catch(()=>undefined);}
  }
}
