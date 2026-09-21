import { isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createDshAgentRemoteProvider, createDshSessionDirectory, mountSharedDshPreset, type DshSharedWebServices, type DshDirectoryContext } from '@orchardworks/dsh';
import { createDshWebInteractionAdapter, type CordisDshRuntimeOptions, type LiveDshProvider, type LiveDshSession } from '@orchardworks/agent-provider-dsh';
import type { AgentProviderAdapter, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { installModelSelection, type ModelSelection } from '@deepseek-ai/dsh-agent';

import { createProtocolValidationServer } from '../server.js';
import { createCodexProviderFixture } from './codex.js';
import { loadCompatibilityManifest } from './compatibility.js';

const workspaceEnvironment = 'BORGEE_LIVE_DSH_WORKSPACE';

export const name = 'borgee-agent-remote-live';
export const inject = ['agentDefaultModel', 'agents', 'sessions'];

export interface Config {
  runtimeMode?: 'standalone' | 'shared-web';
  codexFixture?: boolean;
  compatibilityManifest?: string;
}

type SharedWebServices = Pick<DshSharedWebServices, 'sessionController' | 'agentPresets'>;

type LiveContext = Parameters<typeof createDshAgentRemoteProvider>[0] & Partial<SharedWebServices> & {
  readonly agentDefaultModel: { currentSelection(): ModelSelection };
  readonly planMode?: { set(agent: unknown, active: boolean): unknown };
};

export async function apply(context: LiveContext, config: Config = {}): Promise<void> {
  const workspace = config.runtimeMode === 'shared-web' && !process.env[workspaceEnvironment] ? process.cwd() : requiredAbsolutePath(workspaceEnvironment);
  const codexExecutable = config.codexFixture === false ? undefined : requiredAbsolutePath('BORGEE_CODEX_TEST_EXECUTABLE');
  const relayPort = configuredPort('AGENT_REMOTE_PORT', configuredPort('BORGEE_LIVE_DSH_RELAY_PORT', 5910));
  const labOrigin = new URL(process.env.AGENT_REMOTE_ORIGIN ?? `http://127.0.0.1:${configuredPort('BORGEE_LIVE_DSH_WEB_PORT', 6175)}`).origin;
  const planModeFixture = process.env.BORGEE_LIVE_DSH_PLAN_MODE === '1';
  const compatibility = loadCompatibilityManifest(config.compatibilityManifest);
  const runtimeMode = config.runtimeMode ?? 'standalone';
  if (runtimeMode !== 'standalone' && runtimeMode !== 'shared-web') throw new Error(`Unsupported DSH runtime mode: ${runtimeMode}`);
  const shared = runtimeMode === 'shared-web' ? sharedWebServices(context) : undefined;
  if (planModeFixture && !shared && !context.planMode) throw new Error('The planning fixture requires the DSH planMode service.');
  const interactions = shared ? createDshWebInteractionAdapter(context) : undefined;
  let codex: Awaited<ReturnType<typeof createCodexProviderFixture>> | undefined;
  let server: ReturnType<typeof createProtocolValidationServer> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await server?.close();
    } finally {
      try { await interactions?.dispose(); } finally { await codex?.close(); }
    }
  };
  try {
    const dshProvider = createDshAgentRemoteProvider(context, {
      ...(interactions ? { interactions } : {}),
      async setup(agentContext, request) {
        if (shared) {
          installModelSelection(agentContext, {
            current: selectionForRequest(context.agentDefaultModel.currentSelection(), request),
            assembled: undefined,
          });
          await mountSharedDshPreset(shared.agentPresets, agentContext, request);
          return;
        }
        installModelSelection(agentContext, {
          current: selectionForRequest(context.agentDefaultModel.currentSelection(), request),
          assembled: undefined,
        });
        if (planModeFixture) activatePlanMode(context.planMode!, agentContext, request);
      },
    });
    if (codexExecutable) codex = await createCodexProviderFixture({ executable: codexExecutable, compatibility });
    const dsh = withSessionDefaults(dshProvider, workspace, () => context.agentDefaultModel.currentSelection(), shared !== undefined);
    server = createProtocolValidationServer({ providers: [dsh.provider, ...(codex ? [codex.provider] : [])], labOrigin,
      ...(shared ? { directories: [createDshSessionDirectory(context as unknown as DshDirectoryContext, dshProvider)] } : {}),
    });
    attachLiveControls(server, dsh.stopGeneratedResourceReader, labOrigin);
    const listening = server.http.listen(relayPort, '127.0.0.1');
    context.effect(() => async () => {
      await listening.catch(() => undefined);
      await close();
    });
    await listening;
    process.stdout.write(`Live DSH Agent Remote relay listening on http://127.0.0.1:${relayPort}\n`);
  } catch (error) {
    await close();
    throw error;
  }
}

function sharedWebServices(context: LiveContext): SharedWebServices {
  if (!context.sessionController?.modelCatalog) throw new Error('Shared DSH Web mode requires the sessionController service.');
  if (!context.agentPresets?.mount || !context.agentPresets.composedPreset) throw new Error('Shared DSH Web mode requires the agentPresets service.');
  return { sessionController: context.sessionController, agentPresets: context.agentPresets };
}

function activatePlanMode(
  planMode: NonNullable<LiveContext['planMode']>,
  context: Parameters<NonNullable<CordisDshRuntimeOptions['setup']>>[0],
  request: Parameters<NonNullable<CordisDshRuntimeOptions['setup']>>[1],
): void {
  if (request.kind !== 'create') return;
  const agent = (context as unknown as { agent?: unknown }).agent;
  if (!agent) throw new Error('Compatible DSH runtime must expose the scoped Agent.');
  planMode.set(agent, true);
}

function withSessionDefaults(
  provider: LiveDshProvider,
  workspace: string,
  currentSelection: () => ModelSelection,
  sharedWeb: boolean,
): { provider: AgentProviderAdapter; stopGeneratedResourceReader(sessionId: string): void } {
  const sessions = new Map<string, LiveDshSession>();
  const register = async (sessionId: string, session: LiveDshSession): Promise<LiveDshSession> => {
    sessions.set(sessionId, session);
    return session;
  };
  return {
    provider: {
      descriptor: provider.descriptor,
      async createSession(config: AgentSessionConfig) {
        if (sharedWeb) {
          if (config.model !== undefined || config.reasoningEffort !== undefined) {
            throw new Error('Select the model and reasoning effort in DSH Web when using shared Web mode.');
          }
          return register(config.sessionId, await provider.createSession({ ...config, cwd: config.cwd ?? workspace }));
        }
        const selection = currentSelection();
        const session = await provider.createSession({
          ...config,
          cwd: config.cwd ?? workspace,
          model: config.model ?? selection.model,
          reasoningEffort: config.reasoningEffort ?? selection.reasoningEffort,
        });
        return register(config.sessionId, session);
      },
      async resumeSession(handle) {
        const session = await provider.resumeSession(handle);
        return register(handle.sessionId, session);
      },
    },
    stopGeneratedResourceReader(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Live DSH session was not found: ${sessionId}`);
      session.stopGeneratedResourceReader();
    },
  };
}

function attachLiveControls(
  server: ReturnType<typeof createProtocolValidationServer>,
  stopGeneratedResourceReader: (sessionId: string) => void,
  labOrigin: string,
): void {
  const [relayRequest] = server.http.server.listeners('request') as Array<(
    request: IncomingMessage,
    response: ServerResponse,
  ) => void>;
  if (!relayRequest) throw new Error('Relay request handler is missing.');
  server.http.server.removeListener('request', relayRequest);
  server.http.server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://relay.local');
    const match = /^\/v1\/lab\/live\/([^/]+)\/stop-reader$/.exec(url.pathname);
    if (!match) {
      relayRequest(request, response);
      return;
    }
    if (request.method !== 'POST' || request.headers.origin !== labOrigin) {
      response.writeHead(request.method === 'POST' ? 403 : 405).end();
      return;
    }
    try {
      stopGeneratedResourceReader(decodeURIComponent(match[1] as string));
      response.writeHead(204).end();
    } catch {
      response.writeHead(404).end();
    }
  });
}

export function selectionForRequest(
  fallback: ModelSelection,
  request: Parameters<NonNullable<CordisDshRuntimeOptions['setup']>>[1],
): ModelSelection {
  if (request.kind === 'resume') return fallback;
  return {
    provider: fallback.provider,
    model: request.config.model ?? fallback.model,
    reasoningEffort: (request.config.reasoningEffort ?? fallback.reasoningEffort) as ModelSelection['reasoningEffort'],
  };
}

function configuredPort(environment: string, fallback: number): number {
  const value = process.env[environment];
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${environment} must be an integer from 1 to 65535.`);
  }
  return port;
}

function requiredAbsolutePath(environment: string): string {
  const value = process.env[environment];
  if (value === undefined || !isAbsolute(value)) throw new Error(`${environment} must be an explicit absolute path.`);
  return value;
}
