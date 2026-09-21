import { randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AgentSession, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { DshChildSessions, type LiveDshProvider } from '@orchardworks/agent-provider-dsh';
import { createNativeSessionCatalog, type NativeSessionCatalogServices } from './native-session-catalog.js';
import type { RemoteSessionSummary } from './remote-host-catalog.js';
import type { DshSharedWebServices } from './shared-web-session.js';

export interface DshDirectoryContext extends NativeSessionCatalogServices {
  readonly agents: { roots(): readonly Agent[] };
  readonly sessionTitle?: { get(session: Agent['session']): { title: string } | undefined };
  readonly sessionController: DshSharedWebServices['sessionController'];
  readonly workspaceRegistry: DshSharedWebServices['workspaceRegistry'];
}

export function createDshSessionDirectory(context: DshDirectoryContext, provider: LiveDshProvider) {
  const children = new DshChildSessions(context as never);
  const liveRoots = (): readonly RemoteSessionSummary[] => context.agents.roots()
    .filter((agent) => agent.session.header.origin !== 'subagent')
    .map((agent) => {
      const header = agent.session.header;
      const title = context.sessionTitle?.get(agent.session)?.title ?? String(agent.session.id);
      let updated = header.createdAt;
      for (const event of agent.session.snapshotEvents()) {
        if (typeof event.time === 'number') updated = Math.max(updated, event.time);

      }
      return { nativeSessionId: String(agent.session.id), providerId: 'dsh', title,
        workspace: header.cwd, createdAt: new Date(header.createdAt).toISOString(),
        updatedAt: new Date(updated).toISOString(), state: agent.status === 'running' ? 'running' : 'idle' };
    });
  const list = createNativeSessionCatalog(context, liveRoots);
  return {
    providerId: 'dsh',
    list,
    workspaces: () => context.workspaceRegistry.list().map(({ id, title: name, path }) => ({ id, name, path })),
    models: () => context.sessionController.modelCatalog(),
    async create(input: Partial<AgentSessionConfig> & { workspaceId?: string }): Promise<string> {
      if (input.model !== undefined || input.reasoningEffort !== undefined || input.planning !== undefined) {
        throw new Error('Shared DSH sessions use the model and planning settings selected in DSH Web.');
      }
      if (input.workspaceId !== undefined && !context.workspaceRegistry.list().some(({ id }) => id === input.workspaceId)) {
        throw new Error('The selected DSH workspace is unavailable.');
      }
      const nativeSessionId = randomUUID();
      const created = await context.sessionController.create({ sessionId: nativeSessionId,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      });
      if (created.sessionId !== nativeSessionId) throw new Error('DSH returned an unexpected native session identity.');
      return nativeSessionId;
    },
    openChild: (parentNativeSessionId: string, nativeSessionId: string) => children.open(parentNativeSessionId, nativeSessionId),
    async open(nativeSessionId: string): Promise<AgentSession> {
      const live = context.agents.roots().find((agent) => String(agent.session.id) === nativeSessionId);
      const resolved = live ? { agent: live } : await context.sessionController.resolveAgent(nativeSessionId);
      if (!('agent' in resolved) || resolved.agent.session.header.origin === 'subagent') {
        throw new Error('The native DSH session is unavailable.');
      }
      return children.decorate(nativeSessionId, await provider.borrowSession(resolved.agent));
    },
  };
}
