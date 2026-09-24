import {spawn} from 'node:child_process';
import {mkdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeInvocation} from './platform/executables/index.js';
import {acquireNativeSession,inspectNativeOwner,NativeSessionOwnerError,type NativeSessionLease} from './native-session-owner.js';
import {selectTerminalChoice} from './terminal-select.js';

/** The wrapper owns only its child; leases coordinate explicit managed session IDs. */
export async function runManagedStdioCommand(options: {
 providerId: string; executable: string; profile: string; env: NodeJS.ProcessEnv;
 nativeArgs: string[]; resume?: string; takeover: boolean; verifyReleased(): Promise<void>;
}): Promise<number> {
 const {providerId,executable,profile,env,nativeArgs,resume,takeover,verifyReleased}=options;
  let owner: NativeSessionLease | undefined;
  if (resume && !resume.startsWith('-')) {
    await mkdir(profile,{recursive:true});
    const key={root:join(await realpath(profile),'.arc-session-owners'),providerId,sessionId:resume};
    const acquire=(takeOver?:string)=>acquireNativeSession({...key,kind:'native_cli',takeOver,onDiagnostic:event=>process.stderr.write(JSON.stringify(event)+'\n')});
    try {owner=await acquire(takeover?(await inspectNativeOwner(key))?.generation:undefined);}
    catch(error) {
      if (!(error instanceof NativeSessionOwnerError) || error.code!=='native_session_owned' || !error.owner) throw error;
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${error.message} Run ${providerId} resume ${JSON.stringify(resume)} --take-over to interrupt and take control.`);
      const answer=await selectTerminalChoice(`${error.message} Takeover interrupts running work.`,[
        {value:'takeover',label:'Interrupt and take over'}, {value:'cancel',label:'Cancel'},
      ]);
      if(answer!=='takeover')return 0;
      owner=await acquire(error.owner.generation);
    }
  } else if(takeover) throw new Error('--take-over requires an explicit session ID.');
  let handoff=false, requestedSignal=false;
  try {
    await verifyReleased();
    const child=spawn(...nativeInvocation(executable,nativeArgs),{env,stdio:'inherit'});
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
      child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    const interrupt=()=>{requestedSignal=true;child.kill('SIGINT');};
    const terminate=()=>{requestedSignal=true;child.kill('SIGTERM');};
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    owner?.activate(async()=>{
      handoff=true;
      process.stderr.write('\nControl is moving to another client. Interrupting this native session…\n');
      child.kill('SIGTERM');
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native process did not exit.')),8000);})]);
        await verifyReleased();
        return process.platform==='win32'?'forced':'requested';
      }finally{clearTimeout(timer);}
    });
    try {
      const result=await exited;
      if(!handoff && !requestedSignal && (result.signal || result.code!==0)) process.stderr.write(JSON.stringify({event:'native_process_exited',providerId,sessionId:resume,at:new Date().toISOString(),outcome:'unexpected',code:result.code,signal:result.signal})+'\n');
      if(handoff){process.stderr.write('Native session stopped for the requested handoff.\n');return 0;}
      return result.code??(result.signal==='SIGINT'?130:result.signal==='SIGTERM'?143:1);
    }finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
  } finally {await owner?.release();}
}
