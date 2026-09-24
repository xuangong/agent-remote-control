import type { AgentCapabilities, AgentSession, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeSessionDirectory } from './claude-directory.js';

const capabilities: AgentCapabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
  interactions: { question: false, planApproval: false, toolApproval: false } };

function nativeSession(id: string, cwd = '/work') {
  let disposed = false;
  const session: AgentSession = { capabilities, async *observe() { yield { type: 'history_boundary' }; },
    async runtimeInfo() { return { providerId: 'claude', sessionId: id, cwd, status: disposed ? 'closed' : 'idle',
      persistence: { providerId: 'claude', sessionId: id, opaque: '{}' } }; },
    async sendMessage() {}, async respondToInteraction() {}, async dispose() { disposed = true; } };
  return { session, disposed: () => disposed };
}

describe('Claude Host directory', () => {
  it('delegates child attachment to the loaded parent owner and rejects attachment after close', async () => {
    const child = nativeSession('child');
    const directory = createClaudeSessionDirectory({ listSessions: async () => [], createSession: async () => nativeSession('root').session,
      resumeSession: async () => { throw new Error('Do not resume native children'); },
      async openChildSession(parent, id) { if (parent !== 'root' || id !== 'child') throw new Error('Not a direct child'); return child.session; } }, []);
    expect(await directory.openChild!('root', 'child')).toBe(child.session);
    await expect(directory.openChild!('other', 'child')).rejects.toThrow(/direct child/);
    await directory.close();
    await expect(directory.openChild!('root', 'child')).rejects.toThrow(/closed/);
  });
  it('keeps created sessions available before native persistence and disposes them at Host shutdown', async () => {
    let config: AgentSessionConfig | undefined;
    let created: ReturnType<typeof nativeSession> | undefined;
    const directory = createClaudeSessionDirectory({ async listSessions() { return []; },
      async createSession(input) { config = input; created = nativeSession(input.sessionId, input.cwd); return created.session; },
      async resumeSession() { throw new Error('Created session must remain owned by the Host'); } },
    [{ id: 'workspace', name: 'Workspace', path: '/selected' }]);
    const id = await directory.create({ workspaceId: 'workspace', planning: true, model: 'claude-model' });
    expect(config).toMatchObject({ cwd: '/selected', planning: true, model: 'claude-model' });
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(await directory.open(id)).toBe(created!.session);
    expect(await directory.list()).toEqual([expect.objectContaining({ providerId: 'claude', nativeSessionId: id, workspace: '/selected', state: 'idle' })]);
    expect(directory.openChild).toBeUndefined();
    expect(created!.disposed()).toBe(false);
    await directory.close();
    expect(created!.disposed()).toBe(true);
    await expect(directory.open(id)).rejects.toThrow(/closed/i);
  });

  it('resumes cold native sessions and rejects unknown workspaces before creating', async () => {
    const native = nativeSession('persisted');
    let resumes = 0;
    const directory = createClaudeSessionDirectory({ async listSessions() { return []; },
      async createSession() { throw new Error('must validate workspace'); },
      async resumeSession(handle) { expect(handle).toMatchObject({ providerId: 'claude', sessionId: 'persisted' }); resumes++; return native.session; } }, []);
    await expect(directory.create({ workspaceId: 'unknown' })).rejects.toThrow(/workspace/i);
    expect(await directory.open('persisted')).toBe(native.session);
    expect(await directory.open('persisted')).toBe(native.session);
    expect(resumes).toBe(1);
    await directory.close();
  });

  it('disposes a native session completing initialization after the directory closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const native = nativeSession('late');
    const directory = createClaudeSessionDirectory({ async listSessions() { return []; },
      async createSession() { await gate; return native.session; }, async resumeSession() { throw new Error('unused'); } }, []);
    const creating = directory.create({});
    await directory.close(); release();
    await expect(creating).rejects.toThrow(/closed/i);
    expect(native.disposed()).toBe(true);
  });
});

it('hands a running Controller session to CLI and fences automatic recovery', async () => {
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const {acquireNativeSession,inspectNativeOwner}=await import('./native-session-owner.js');
  const root=await mkdtemp(join(tmpdir(),'arc-directory-owner-')); let releases=0;
  const directory=createClaudeSessionDirectory({listSessions:async()=>[], createSession:async()=>nativeSession('native').session,
    resumeSession:async()=>nativeSession('native').session, async releaseSession(){releases++;}},[],{root});
  let cli:Awaited<ReturnType<typeof acquireNativeSession>>|undefined;
  try {
    const session=await directory.open('native');
    const owner=await inspectNativeOwner({root,providerId:'claude',sessionId:'native'});
    cli=await acquireNativeSession({root,providerId:'claude',sessionId:'native',kind:'native_cli',takeOver:owner!.generation});cli.activate(async()=> 'requested');
    expect(releases).toBe(1);
    await expect(session.sendMessage('stale')).rejects.toThrow(/control|ownership/i);
    await expect(directory.open('native')).rejects.toMatchObject({code:'native_session_owned'});
    await cli.release();
    await expect(directory.open('native')).rejects.toMatchObject({code:'native_session_released'});
    await directory.open('native',{takeOver:cli.generation});
  }finally{await cli?.release();await directory.close();await rm(root,{recursive:true,force:true});}
},5000);

it('checks a cold Claude workspace by ID without relying on the catalog', async () => {
  const {createHostExecutionPolicy, protectHostDirectory} = await import('./execution-policy.js');
  const {realpath} = await import('node:fs/promises');
  const cwd = await realpath(process.cwd());
  const lookup = vi.fn(async () => cwd as string | undefined);
  const resume = vi.fn(async () => nativeSession('cold', cwd).session);
  const list = vi.fn(async () => []);
  const source = createClaudeSessionDirectory({listSessions: list, sessionWorkspace: lookup,
    createSession: async () => {throw new Error('unused');}, resumeSession: resume}, []);
  const directory = protectHostDirectory(source, (await createHostExecutionPolicy({AGENT_HOST_WORKSPACE: cwd}))!);
  try {
    expect((await (await directory.open('cold')).runtimeInfo()).cwd).toBe(cwd);
    expect(lookup).toHaveBeenCalledWith('cold');
    expect(list).not.toHaveBeenCalled();
    lookup.mockResolvedValue(undefined);
    await expect(directory.open('missing')).rejects.toThrow(/workspace/i);
    lookup.mockResolvedValue('/');
    await expect(directory.open('outside')).rejects.toThrow(/workspace/i);
    expect(resume).toHaveBeenCalledTimes(1);
  } finally {await directory.close();}
}, 10000);
