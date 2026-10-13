import { createHash, randomUUID } from 'node:crypto';
import type { TeamResource } from '@orchardworks/agent-remote-protocol';

export interface TeamResourceDeclaration { uploadId: string; name: string; mediaType: string; byteLength: number; sha256: string }
export interface TeamResourceReceipt { uploadId: string; offset: number; resource?: TeamResource }
export interface TeamResourceChunk { uploadId: string; offset: number; contentBase64: string }
export interface TeamResourceStore {
  begin(scope: string, declaration: TeamResourceDeclaration): Promise<TeamResourceReceipt>;
  chunk(scope: string, chunk: TeamResourceChunk): Promise<TeamResourceReceipt>;
  finish(scope: string, uploadId: string): Promise<TeamResourceReceipt>;
  getMetadata(scope: string, resourceId: string): Promise<TeamResource>;
  readChunk(scope: string, resourceId: string, offset: number): Promise<TeamResource & { offset: number; contentBase64: string }>;
  pin(scope: string, resourceId: string): Promise<void>;
}
/** Keys are opaque. Each value fits within a Durable Object storage value limit. */
export interface TeamResourceStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
interface Manifest extends TeamResourceDeclaration {
  scopeHash: string; key: string; resourceId: string; offset: number; touchedAt: number; pinned: boolean; complete: boolean;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const CHUNK_BYTES = 32768;
const MAX_BYTES = 50 * 1024 * 1024;
const metadata = ({resourceId,name,mediaType,byteLength,sha256}:Manifest):TeamResource => ({resourceId,name,mediaType,byteLength,sha256});
function parseManifest(bytes:Uint8Array, key:string):Manifest {
  const value=JSON.parse(Buffer.from(bytes).toString('utf8')) as Manifest;
  if(!value||value.key!==key||!/^([a-f0-9]{64})$/.test(value.scopeHash)||typeof value.uploadId!=='string'||!value.uploadId||value.uploadId.length>256||typeof value.resourceId!=='string'||!value.resourceId||value.resourceId.length>256||typeof value.name!=='string'||!value.name||value.name.length>255||/[\x00-\x1f]/.test(value.name)||typeof value.mediaType!=='string'||!value.mediaType||value.mediaType.length>255||!Number.isSafeInteger(value.byteLength)||value.byteLength<0||value.byteLength>MAX_BYTES||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>value.byteLength||value.offset!==value.byteLength&&value.offset%CHUNK_BYTES!==0||!Number.isFinite(value.touchedAt)||typeof value.pinned!=='boolean'||typeof value.complete!=='boolean'||value.complete&&value.offset!==value.byteLength||!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error('Corrupt resource metadata.');
  return value;
}
const receipt = (manifest:Manifest):TeamResourceReceipt => ({uploadId:manifest.uploadId,offset:manifest.offset,...(manifest.complete?{resource:metadata(manifest)}:{})});

/** Persistent chunk storage for Node and Cloudflare; Team membership remains broker-owned. */
export class PortableTeamResourceStore implements TeamResourceStore {
  private tail:Promise<unknown> = Promise.resolve();
  private readonly now:()=>number;
  private readonly quota:number;
  private readonly ttl:number;
  constructor(private readonly options:{storage:TeamResourceStorage;quotaBytes?:number;draftTtlMs?:number;now?:()=>number}) {
    this.now=options.now??Date.now;this.quota=options.quotaBytes??1024*1024*1024;this.ttl=options.draftTtlMs??86400000;
    if(!Number.isSafeInteger(this.quota)||this.quota<1||!Number.isFinite(this.ttl)||this.ttl<=0)throw new Error('Invalid resource storage limits.');
  }
  private serial<T>(run:()=>Promise<T>):Promise<T>{const pending=this.tail.then(run);this.tail=pending.catch(()=>undefined);return pending;}
  private async manifests():Promise<Manifest[]>{
    const output:Manifest[]=[];
    for(const key of await this.options.storage.list('manifest:')){const value=await this.options.storage.get(key);if(value)output.push(parseManifest(value,key.slice('manifest:'.length)));}
    return output;
  }
  private async persist(value:Manifest){await this.options.storage.put(`manifest:${value.key}`,Buffer.from(JSON.stringify(value)));}
  private async load(scope:string,uploadId:string):Promise<Manifest>{
    const key=hash(JSON.stringify([scope,uploadId])),value=await this.options.storage.get(`manifest:${key}`);
    if(!value)throw new Error('Resource upload unavailable.');const result=parseManifest(value,key);if(result.scopeHash!==hash(scope)||result.uploadId!==uploadId)throw new Error('Resource upload identity mismatch.');if(!result.pinned&&this.now()-result.touchedAt>this.ttl)throw new Error('Resource upload unavailable or expired.');return result;
  }
  private async resource(scope:string,resourceId:string):Promise<Manifest>{
    const index=await this.options.storage.get(`resource:${hash(resourceId)}`);
    if(!index)throw new Error('Resource unavailable.');
    const key=Buffer.from(index).toString('utf8');if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Corrupt resource index.');
    const bytes=await this.options.storage.get(`manifest:${key}`);if(!bytes)throw new Error('Resource unavailable.');
    const value=parseManifest(bytes,key);
    if(value.scopeHash!==hash(scope)||value.resourceId!==resourceId||!value.complete||!value.pinned&&this.now()-value.touchedAt>this.ttl)throw new Error('Resource unavailable.');return value;
  }
  private async expire(){
    for(const item of await this.manifests())if(!item.pinned&&this.now()-item.touchedAt>this.ttl){
      for(const key of await this.options.storage.list(`chunk:${item.key}:`))await this.options.storage.delete(key);
      await this.options.storage.delete(`resource:${hash(item.resourceId)}`);
      await this.options.storage.delete(`manifest:${item.key}`);
    }
  }
  begin(scope:string,input:TeamResourceDeclaration):Promise<TeamResourceReceipt>{return this.serial(async()=>{
    if(!scope||!input.uploadId||input.uploadId.length>256||!input.name||input.name.length>255||/[\x00-\x1f]/.test(input.name)||!input.mediaType||input.mediaType.length>255||!Number.isSafeInteger(input.byteLength)||input.byteLength<0||input.byteLength>MAX_BYTES||!/^[a-f0-9]{64}$/.test(input.sha256))throw new Error('Invalid resource declaration; maximum file size is 50 MiB.');
    await this.expire();const key=hash(JSON.stringify([scope,input.uploadId])),saved=await this.options.storage.get(`manifest:${key}`);
    if(saved){const existing=parseManifest(saved,key);
      if(existing.sha256!==input.sha256||existing.byteLength!==input.byteLength||existing.name!==input.name||existing.mediaType!==input.mediaType)throw new Error('Resource upload identity conflicts.');
      existing.touchedAt=this.now();await this.persist(existing);return receipt(existing);}
    const manifests=await this.manifests();
    if(manifests.length>=8192||manifests.reduce((total,item)=>total+item.byteLength,0)+input.byteLength>this.quota)throw new Error('Resource storage quota exceeded.');
    const value:Manifest={...input,key,scopeHash:hash(scope),resourceId:randomUUID(),offset:0,touchedAt:this.now(),pinned:false,complete:false};await this.persist(value);return receipt(value);
  });}
  chunk(scope:string,input:TeamResourceChunk):Promise<TeamResourceReceipt>{return this.serial(async()=>{
    const value=await this.load(scope,input.uploadId),bytes=Buffer.from(input.contentBase64,'base64');
    if(!Number.isSafeInteger(input.offset)||input.offset<0||input.offset%CHUNK_BYTES!==0||!bytes.length||bytes.length>CHUNK_BYTES||bytes.toString('base64')!==input.contentBase64||input.offset+bytes.length>value.byteLength||bytes.length<CHUNK_BYTES&&input.offset+bytes.length!==value.byteLength)throw new Error('Invalid resource chunk.');
    const key=`chunk:${value.key}:${input.offset}`;
    if(input.offset<value.offset){const previous=await this.options.storage.get(key);if(previous&&Buffer.from(previous).equals(bytes))return receipt(value);throw new Error('Resource chunk conflicts with accepted bytes.');}
    if(value.complete||input.offset!==value.offset)throw new Error('Resource chunk offset does not match receipt.');
    await this.options.storage.put(key,bytes);value.offset+=bytes.length;value.touchedAt=this.now();await this.persist(value);return receipt(value);
  });}
  finish(scope:string,uploadId:string):Promise<TeamResourceReceipt>{return this.serial(async()=>{
    const value=await this.load(scope,uploadId);if(value.complete){await this.options.storage.put(`resource:${hash(value.resourceId)}`,Buffer.from(value.key));return receipt(value);}
    if(value.offset!==value.byteLength)throw new Error('Resource upload is incomplete.');
    const digest=createHash('sha256');let size=0;
    for(let offset=0;offset<value.byteLength;offset+=CHUNK_BYTES){const bytes=await this.options.storage.get(`chunk:${value.key}:${offset}`);if(!bytes)throw new Error('Resource upload integrity failure.');size+=bytes.length;digest.update(bytes);}
    if(size!==value.byteLength||digest.digest('hex')!==value.sha256)throw new Error('Resource upload integrity failure.');
    value.complete=true;value.touchedAt=this.now();await this.persist(value);await this.options.storage.put(`resource:${hash(value.resourceId)}`,Buffer.from(value.key));return receipt(value);
  });}
  getMetadata(scope:string,resourceId:string):Promise<TeamResource>{return this.serial(async()=>metadata(await this.resource(scope,resourceId)));}
  readChunk(scope:string,resourceId:string,offset:number):Promise<TeamResource & {offset:number;contentBase64:string}>{return this.serial(async()=>{
    const value=await this.resource(scope,resourceId);
    if(!Number.isSafeInteger(offset)||offset<0||offset>value.byteLength||offset%CHUNK_BYTES!==0)throw new Error('Invalid resource read offset.');
    const bytes=offset===value.byteLength?new Uint8Array():await this.options.storage.get(`chunk:${value.key}:${offset}`);
    if(!bytes)throw new Error('Resource bytes unavailable.');
    return {...metadata(value),offset,contentBase64:Buffer.from(bytes).toString('base64')};
  });}
  pin(scope:string,resourceId:string):Promise<void>{return this.serial(async()=>{const value=await this.resource(scope,resourceId);value.pinned=true;await this.persist(value);});}
}
