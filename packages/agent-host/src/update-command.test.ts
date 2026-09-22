import { expect, it } from 'vitest';
import { runControllerUpdate } from './update-command.js';
const identity = { version: '0.1.0', revision: 'a'.repeat(40), platform: 'linux', arch: 'arm64', nodeMajor: 22, remoteUpdate: true };
const release = { protocolVersion: '1.5.0', version: '0.2.0', revision: 'b'.repeat(40), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', sha256: 'c'.repeat(64), nodeMajor: 22, platforms: ['linux-arm64'] };
function fixture(overrides = {}) {
  const calls: Record<string, unknown>[] = [], output: string[] = [];
  const deps = { print: (s: string) => { output.push(s); }, release: async () => release,
    call: async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
      calls.push(request);
      if (request.action === 'controller-info') return { identity, cleanInstall:true, status: { phase: 'idle' } };
      return { phase: 'waiting', operationId: request.operationId, version: request.version };
    }, ...overrides };
  return { calls, output, deps };
}
it('checks compatibility against the running Host without scheduling an update', async () => {
  const f=fixture(); await runControllerUpdate(['--check'], f.deps);
  expect(JSON.parse(f.output.join(''))).toMatchObject({ current:'0.1.0', version:'0.2.0', available:true });
  expect(f.calls).toEqual([{action:'controller-info'}]);
});
it.each([{...release,nodeMajor:24},{...release,platforms:['darwin-arm64']},{...release,version:'0.1.0'},{...release,protocolVersion:'99.0.0'}])('does not offer incompatible or older releases', async candidate => {
  const f=fixture({release:async()=>candidate});await runControllerUpdate(['--check'],f.deps);
  expect(JSON.parse(f.output.join('')).available).toBe(false);
});
it('requires explicit consent and a pinned version for mutation', async () => {
  for(const args of [[],['--version','0.2.0'],['--yes']]) {
    const f=fixture();await expect(runControllerUpdate(args,f.deps)).rejects.toThrow();expect(f.calls).toEqual([]);
  }
});
it('reports safe-window waiting without pretending activation completed', async () => {
  const f=fixture();await runControllerUpdate(['--version','0.2.0','--yes'],f.deps);
  expect(f.calls[1]).toMatchObject({ action:'controller-update', version:'0.2.0', operationId:expect.any(String) });
  expect(f.output.join('')).toContain('safe restart window');
});
it('reports a failed activation and never sends a second update intent', async () => {
  const f=fixture({call:async (r:Record<string,unknown>) => {
    f.calls.push(r);
    if(r.action==='controller-info')return {identity,status:{phase:'idle'}};
    return {phase:'failed',message:'The previous version was restored.'};
  }});
  await expect(runControllerUpdate(['--version','0.2.0','--yes'],f.deps)).rejects.toThrow('previous version was restored');
  expect(f.calls.filter(c=>c.action==='controller-update')).toHaveLength(1);
});

it('offers explicit clean reinstall for an up-to-date managed launcher',async()=>{
 const f=fixture({release:async()=>({...release,version:identity.version})});
 await runControllerUpdate(['--check'],f.deps);
 expect(JSON.parse(f.output.join(''))).toMatchObject({available:false,canClean:true});
 await runControllerUpdate(['--version',identity.version,'--yes','--clean'],f.deps);
 expect(f.calls.at(-1)).toMatchObject({action:'controller-update',clean:true,version:identity.version});
});
