import {createHash, randomUUID, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';

export type NativeOwnerKind = 'controller' | 'native_cli';
export type NativeHandoffOutcome = 'requested' | 'forced';
export interface NativeOwnerIdentity { kind: NativeOwnerKind; generation: string }
interface OwnerRecord extends NativeOwnerIdentity { pid:number; port:number; token:string; outcome?:NativeHandoffOutcome }
interface NativeSessionKey { root:string; providerId:string; sessionId:string }
export class NativeSessionOwnerError extends Error {
  constructor(readonly code:string, message:string, readonly owner?:NativeOwnerIdentity) {super(message);}
}
export interface NativeSessionLease {
  readonly generation:string;
  readonly active:boolean;
  readonly previousOutcome?:NativeHandoffOutcome;
  activate(stop:(next: NativeOwnerIdentity)=>Promise<NativeHandoffOutcome>, transferred?: (next: NativeOwnerIdentity) => void):void;
  release():Promise<void>;
}
export interface NativeOwnerDiagnostic { event:string; providerId:string; sessionId:string; generation:string; at:string; outcome?:string }
function location(key:NativeSessionKey) { return join(key.root,createHash('sha256').update(JSON.stringify([key.providerId,key.sessionId])).digest('hex')); }
function read(path:string):OwnerRecord|undefined {
  try {const record: unknown = JSON.parse(readFileSync(path,'utf8')); if (!validRecord(record)) throw new Error('Invalid ownership record.'); return record;} catch(error) {
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return undefined;
    throw new NativeSessionOwnerError('native_handoff_unknown','Native ownership cannot be verified. Check the Controller log.');
  }
}
function alive(pid:number) {try {process.kill(pid,0);return true;} catch(error) {return (error as NodeJS.ErrnoException).code!=='ESRCH';} }
function identity(owner:OwnerRecord):NativeOwnerIdentity {return {kind:owner.kind,generation:owner.generation};}
/** Only synchronous file operations run inside this cross-process compare-and-swap gate. */
function locked<T>(path:string, action:()=>T):T {
  try {mkdirSync(path+'.gate',{mode:0o700});} catch {throw new NativeSessionOwnerError('native_owner_busy','Native ownership is changing. Retry after checking the session.');}
  try {return action();} finally {rmdirSync(path+'.gate');}
}
function replace(path:string,record:OwnerRecord) {
  const temp=path+'.'+randomUUID(); writeFileSync(temp,JSON.stringify(record),{mode:0o600});
  try {renameSync(temp,path);} catch(error) {try {unlinkSync(temp);} catch {} throw error;}
}
export async function inspectNativeOwner(key:NativeSessionKey):Promise<NativeOwnerIdentity|undefined> {
  const record=read(location(key)); return record && alive(record.pid) ? identity(record) : undefined;
}
function authorize(actual:string|undefined, expected:string) {const a=Buffer.from(actual??''),b=Buffer.from(expected);return a.length===b.length && timingSafeEqual(a,b);}
function validRecord(value:unknown):value is OwnerRecord {
  const v=value as OwnerRecord|undefined;
  return !!v && (v.kind==='controller'||v.kind==='native_cli') && typeof v.generation==='string' && /^[a-f\d-]{36}$/i.test(v.generation)
    && Number.isSafeInteger(v.pid) && v.pid>0 && Number.isSafeInteger(v.port) && v.port>0 && v.port<65536
    && typeof v.token==='string' && /^[a-f\d]{64}$/.test(v.token);
}
export async function acquireNativeSession(options:NativeSessionKey & {kind:NativeOwnerKind; takeOver?:string; requestTimeoutMs?:number; onDiagnostic?:(event:NativeOwnerDiagnostic)=>void}):Promise<NativeSessionLease> {
  mkdirSync(options.root,{recursive:true,mode:0o700});
  const path=location(options), generation=randomUUID(), token=randomBytes(32).toString('hex');
  const reservation=(id:string)=>path+'.reservation-'+id;
  let owned=false, active=false, released=false, stop:((next: NativeOwnerIdentity)=>Promise<NativeHandoffOutcome>)|undefined;
  let transferred: ((next: NativeOwnerIdentity) => void) | undefined;
  let transfer:Promise<NativeHandoffOutcome>|undefined, successor:string|undefined, previousOutcome:NativeHandoffOutcome|undefined;
  const diagnose=(event:string,outcome?:string)=> {try {options.onDiagnostic?.({event,providerId:options.providerId,sessionId:options.sessionId,generation,at:new Date().toISOString(),...(outcome?{outcome}:{})});}catch{}};
  const server=createServer((req,res)=> {
    const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    if(req.method!=='POST'||req.url!=='/takeover'||!authorize(req.headers.authorization,token)) {send(403,{code:'native_handoff_unauthorized'});return;}
    let body=''; req.setTimeout(15000,()=>req.destroy());
    req.on('data',chunk=>{body+=chunk;if(body.length>4096)req.destroy();});
    req.on('end',()=>void (async()=>{
      let next:OwnerRecord; try {next=JSON.parse(body);}catch{send(400,{code:'invalid_request'});return;}
      if(!validRecord(next)){send(400,{code:'invalid_request'});return;}
      if(successor && successor!==next.generation){send(409,{code:'native_owner_changed'});return;}
      if(!transfer) {
        if(!owned||!active||!stop){send(409,{code:'native_owner_busy'});return;}
        successor=next.generation; active=false; diagnose('native_handoff_started');
        transfer=(async()=>{
          try {
            const outcome=await stop!(identity(next));
            locked(path,()=>{
              if(read(path)?.generation!==generation)throw new Error('Native owner changed during release.');
              const candidate=read(reservation(next.generation));
              if (!candidate || candidate.token!==next.token || candidate.port!==next.port || candidate.pid!==next.pid || candidate.kind!==next.kind || !alive(next.pid)) {
                unlinkSync(path); owned=false;
                throw new Error('The requester left before native release completed.');
              }
              replace(path,{...next,outcome}); unlinkSync(reservation(next.generation));
            });
            owned=false; try {transferred?.(identity(next));} catch {} diagnose('native_handoff_completed',outcome); return outcome;
          }catch(error){diagnose('native_handoff_failed','unknown');if(!owned){server.close();server.closeIdleConnections();}throw error;}
        })();
      }
      try {const outcome=await transfer; res.once('finish',()=>{server.close();server.closeIdleConnections();}); send(200,{outcome});}catch{send(409,{code:'native_handoff_unknown'});}
    })().catch(()=>send(409,{code:'native_handoff_unknown'})));
  });
  server.requestTimeout=15000; server.headersTimeout=5000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Native management endpoint unavailable.');
  const record:OwnerRecord={kind:options.kind,generation,pid:process.pid,port:address.port,token};
  const close=()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});
  try {
    const prior=locked(path,()=>{
      const prior=read(path);
      if(prior && alive(prior.pid))return prior;
      if(options.takeOver && prior && prior.generation!==options.takeOver)throw new NativeSessionOwnerError('native_owner_changed','The native owner changed. Inspect the session before taking over again.');
      if(prior)diagnose('native_owner_exited','unexpected');
      replace(path,record);owned=true;return undefined;
    });
    if(prior){
      if(!options.takeOver)throw new NativeSessionOwnerError('native_session_owned',prior.kind==='native_cli'?'This session is open in the native CLI.':'This session is controlled by another Controller client.',identity(prior));
      if(prior.generation!==options.takeOver)throw new NativeSessionOwnerError('native_owner_changed','The native owner changed. Inspect the session before taking over again.',identity(prior));
      locked(path,()=>{
        if(read(path)?.generation!==prior.generation) throw new NativeSessionOwnerError('native_owner_changed','Native ownership changed before takeover.');
        replace(reservation(generation),record);
      });
      let response:Response;
      try {response=await fetch(`http://127.0.0.1:${prior.port}/takeover`,{method:'POST',headers:{authorization:prior.token,'content-type':'application/json'},body:JSON.stringify(record),signal:AbortSignal.timeout(options.requestTimeoutMs??12000)});}
      catch {throw new NativeSessionOwnerError('native_handoff_unknown','The old owner did not confirm release. No new native writer was started.');}
      const result=await response.json() as {code?:string;outcome?:NativeHandoffOutcome};
      if(!response.ok)throw new NativeSessionOwnerError(result.code??'native_handoff_unknown','Native takeover was not confirmed. Check the session before retrying.');
      if(read(path)?.generation!==generation)throw new NativeSessionOwnerError('native_owner_changed','Native ownership changed before startup.');
      owned=true;previousOutcome=result.outcome;diagnose('native_handoff_received',previousOutcome);
    }
  }catch(error){
    // Withdrawal and transfer commit use the same gate. A late release cannot
    // assign ownership to an endpoint that already abandoned its request.
    try {locked(path,()=>{
      if(read(reservation(generation)))unlinkSync(reservation(generation));
      if(read(path)?.generation===generation)unlinkSync(path);
    });}catch{diagnose('native_handoff_cleanup_failed','unknown');}
    await close();throw error;
  }
  return {
    generation,get active(){return active;},get previousOutcome(){return previousOutcome;},
    activate(callback, onTransferred){transferred=onTransferred;if(!owned||released||successor)throw new Error('Native lease is unavailable.');stop=callback;active=true;},
    async release(){
      if(released)return;released=true;active=false;
      await transfer?.catch(()=>undefined);
      if(owned)locked(path,()=>{if(read(path)?.generation===generation)unlinkSync(path);owned=false;});
      await close();
    },
  };
}
