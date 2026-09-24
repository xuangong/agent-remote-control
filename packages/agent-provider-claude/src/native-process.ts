import {spawn} from 'node:child_process';
import type {SpawnOptions, SpawnedProcess} from '@anthropic-ai/claude-agent-sdk';
import {deadline} from './channel.js';

/** Query.close starts shutdown; handoff requires observing the owned process exit. */
export class ClaudeNativeProcess {
 private exited?: Promise<void>;
 private requested = false;
 constructor(private readonly diagnostic?: (line: string) => void) {}
 readonly spawn = (options: SpawnOptions): SpawnedProcess => {
  const child = spawn(options.command, options.args, {cwd:options.cwd,env:options.env,signal:options.signal,stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stderr.on('data', chunk=>{try {this.diagnostic?.(String(chunk));} catch {}});
  this.exited = new Promise<void>((resolve)=>{
   // A spawn error without a PID proves that no native writer was created.
   child.once('error', ()=>{if (!child.pid) resolve();});
   child.once('exit', (code,signal)=>{
    try {this.diagnostic?.(JSON.stringify({event:'native_process_exited',providerId:'claude',at:new Date().toISOString(),code,signal,
     outcome:this.requested ? signal || code !== 0 ? 'forced' : 'requested' : 'unexpected'}));} catch {}
    resolve();
   });
  });
  void this.exited.catch(()=>undefined);
  return child;
 };
 requestShutdown(): void {this.requested=true;}
 get started(): boolean {return !!this.exited;}
 async waitForExit(timeout: number): Promise<void> {
  if (!this.exited) throw new Error('Claude native process was not started; release cannot be confirmed.');
  await deadline(this.exited,timeout,'Claude native process release');
 }
}
