import type { CordisDshRuntimeOptions } from '@borgee/agent-provider-dsh';
import type { Agent } from '@deepseek-ai/dsh-agent';

type AgentContext = Parameters<NonNullable<CordisDshRuntimeOptions['setup']>>[0];
type SetupRequest = Parameters<NonNullable<CordisDshRuntimeOptions['setup']>>[1];

export interface DshSharedWebServices {
  readonly sessionController: {
    create(request: { sessionId?: string; workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>;
    resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: unknown }>;
    modelCatalog(): Promise<unknown>;
  };
  readonly workspaceRegistry: {
    list(): readonly { id: string; title: string; path: string }[];
  };
  readonly agentPresets: {
    composedPreset(context: AgentContext): string | undefined;
    mount(context: AgentContext, preset?: string): Promise<{ id: string }>;
  };
}

export async function mountSharedDshPreset(
  presets: DshSharedWebServices['agentPresets'],
  context: AgentContext,
  request: SetupRequest,
): Promise<void> {
  if (presets.composedPreset(context) !== undefined) return;
  const session = (context as unknown as { agent?: { session: {
    header: { agentPreset?: string };
    snapshotEvents(): readonly { type: string; data: unknown }[];
    append(type: 'agent-preset/selected', data: { agentPreset: string }): unknown;
  } } }).agent?.session;
  if (!session) throw new Error('Compatible DSH runtime must expose the scoped Agent session.');
  let selected = session.header.agentPreset;
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'agent-preset/selected') continue;
    const data = event.data as { agentPreset?: unknown };
    if (typeof data?.agentPreset === 'string') selected = data.agentPreset;
    break;
  }
  const preset = await presets.mount(context, selected);
  if (request.kind === 'create') session.append('agent-preset/selected', { agentPreset: preset.id });
}
