import {expect,it} from 'vitest';
import {ClaudeNativeProcess} from './native-process.js';

it('waits for native process exit rather than accepting stdin close as release', async () => {
 const runtime=new ClaudeNativeProcess();
 const child=runtime.spawn({command:process.execPath,args:['-e',"process.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>process.exit(0),150));"],env:process.env,signal:new AbortController().signal});
 child.stdin.end();let exited=false;const waiting=runtime.waitForExit(2000).then(()=>{exited=true;});
 await new Promise(resolve=>setTimeout(resolve,20));expect(exited).toBe(false);await waiting;
 expect(child.exitCode).toBe(0);
});

it('does not confirm release without a started native process', async () => {
 await expect(new ClaudeNativeProcess().waitForExit(50)).rejects.toThrow(/not started/);
});

it('confirms no writer exists when process creation itself fails', async () => {
 const runtime=new ClaudeNativeProcess();
 runtime.spawn({command:'/arc-nonexistent-claude-binary',args:[],env:process.env,signal:new AbortController().signal});
 await expect(runtime.waitForExit(1000)).resolves.toBeUndefined();
});
