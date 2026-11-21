import type { V2Event } from '@opencode/client';

/**
 * The event types the OpenCode adapter knows (`@opencode/client` 2.0.25, `V2Event`): it handles each of them or leaves it out on purpose,
 * and an `rpc.*` event is a reply of the server's own RPC. An event of any other type is one the adapter does not know, which becomes one
 * diagnostic, never a row and never a refresh (gap 10, `agent-provider-sdk/src/native-events.ts`). The list names every type the client
 * declares, which the compiler checks, so a client update that adds one fails the build until the adapter decides what it is. History is
 * the server's message list, read whole at each refresh; its message types are the schema's.
 */
const EVENT_TYPES = [
  'agent.updated', 'command.updated', 'config.updated', 'credential.switched', 'credential.updated', 'filesystem.changed', 'form.cancelled',
  'form.created', 'form.replied', 'installation.update-available', 'installation.updated', 'integration.updated', 'location.shutdown',
  'mcp.resources.changed', 'mcp.status.changed', 'model.updated', 'models-dev.refreshed', 'permission.asked', 'permission.replied',
  'persistent-pty.added', 'persistent-pty.removed', 'plugin.updated', 'project.updated', 'provider.updated', 'pty.created', 'pty.deleted',
  'pty.exited', 'pty.updated', 'reference.updated', 'server.connected', 'session.agent.selected', 'session.compaction.delta',
  'session.compaction.ended', 'session.compaction.failed', 'session.compaction.started', 'session.created', 'session.deleted',
  'session.execution.failed', 'session.execution.interrupted', 'session.execution.started', 'session.execution.succeeded', 'session.forked',
  'session.idle', 'session.inbox.cancelled', 'session.inbox.delivered', 'session.inbox.delivery.changed', 'session.inbox.enqueued',
  'session.instructions.updated', 'session.metadata.updated', 'session.model.selected', 'session.moved', 'session.permissions',
  'session.reasoning.delta', 'session.reasoning.ended', 'session.reasoning.started', 'session.renamed', 'session.retry.scheduled',
  'session.revert.cleared', 'session.revert.committed', 'session.revert.staged', 'session.shell.ended', 'session.shell.started',
  'session.skill.activated', 'session.status', 'session.step.ended', 'session.step.failed', 'session.step.started', 'session.step.streamed',
  'session.synthetic', 'session.text.delta', 'session.text.ended', 'session.text.started', 'session.tool.called', 'session.tool.failed',
  'session.tool.input.delta', 'session.tool.input.ended', 'session.tool.input.started', 'session.tool.progress', 'session.tool.success',
  'session.usage.updated', 'session.viewed', 'shell.created', 'shell.deleted', 'shell.exited', 'skill.updated', 'tui.command.execute',
  'tui.prompt.append', 'tui.session.select', 'tui.toast.show', 'vcs.branch.updated', 'websearch.updated', 'worktree.resolved', 'worktree.updated',
] as const satisfies readonly V2Event['type'][];
// Compiles only while the list, with the RPC replies, names every type the client declares.
export const everyEventTypeListed: readonly ((typeof EVENT_TYPES)[number] | `rpc.${string}`)[] = [] as V2Event['type'][];

const eventTypes = new Set<string>(EVENT_TYPES);

/** Whether the adapter knows an event's type. */
export const knownOpenCodeEvent = (type: unknown): boolean => typeof type === 'string' && (eventTypes.has(type) || type.startsWith('rpc.'));
