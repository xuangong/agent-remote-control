import type { SessionEvent } from '@github/copilot-sdk';

/**
 * The session event types the Copilot adapter knows (`@github/copilot-sdk` 1.0.11, `dist/generated/session-events.d.ts`): it projects each of
 * them or leaves it out on purpose. An event of any other type is one the adapter does not know, which becomes one diagnostic and never a
 * row (gap 10, `agent-provider-sdk/src/native-events.ts`). The list names every type the SDK declares, which the compiler checks, so an SDK
 * update that adds one fails the build until the adapter decides what it is.
 */
const EVENT_TYPES = [
  'abort', 'assistant.idle', 'assistant.intent', 'assistant.message', 'assistant.message_delta', 'assistant.message_start', 'assistant.reasoning',
  'assistant.reasoning_delta', 'assistant.server_tool_progress', 'assistant.streaming_delta', 'assistant.tool_call_delta', 'assistant.turn_end',
  'assistant.turn_start', 'assistant.usage', 'auto_mode_switch.completed', 'auto_mode_switch.requested', 'capabilities.changed', 'command.completed',
  'command.execute', 'command.queued', 'commands.changed', 'elicitation.completed', 'elicitation.requested', 'exit_plan_mode.completed',
  'exit_plan_mode.requested', 'external_tool.completed', 'external_tool.requested', 'factory.run_updated', 'hook.end', 'hook.progress', 'hook.start',
  'mcp.headers_refresh_completed', 'mcp.headers_refresh_required', 'mcp.oauth_completed', 'mcp.oauth_required', 'mcp.prompts.list_changed',
  'mcp.resources.list_changed', 'mcp.tools.list_changed', 'mcp_app.tool_call_complete', 'model.call_failure', 'pending_messages.modified',
  'permission.completed', 'permission.requested', 'sampling.completed', 'sampling.requested', 'session.auto_mode_resolved',
  'session.autopilot_objective_changed', 'session.background_tasks_changed', 'session.binary_asset', 'session.canvas.closed',
  'session.canvas.opened', 'session.canvas.recorded', 'session.canvas.registry_changed', 'session.canvas.removed', 'session.canvas.unavailable',
  'session.compaction_complete', 'session.compaction_start', 'session.context_changed', 'session.context_cleared', 'session.custom_agents_updated',
  'session.custom_notification', 'session.error', 'session.extensions.attachments_pushed', 'session.extensions_loaded', 'session.handoff',
  'session.idle', 'session.info', 'session.managed_settings_enforced', 'session.managed_settings_resolved', 'session.mcp_server_status_changed',
  'session.mcp_servers_loaded', 'session.mode_changed', 'session.model_change', 'session.permissions_changed', 'session.plan_changed',
  'session.remote_steerable_changed', 'session.resume', 'session.schedule_cancelled', 'session.schedule_created', 'session.schedule_rearmed',
  'session.session_limits_changed', 'session.shutdown', 'session.skills_loaded', 'session.snapshot_rewind', 'session.start', 'session.task_complete',
  'session.title_changed', 'session.todos_changed', 'session.tools_updated', 'session.truncation', 'session.usage_checkpoint', 'session.usage_info',
  'session.warning', 'session.workspace_file_changed', 'session_limits_exhausted.completed', 'session_limits_exhausted.requested', 'skill.invoked',
  'subagent.completed', 'subagent.deselected', 'subagent.failed', 'subagent.selected', 'subagent.started', 'system.message', 'system.notification',
  'tool.execution_complete', 'tool.execution_partial_result', 'tool.execution_progress', 'tool.execution_start', 'tool.user_requested',
  'tool_search.activated', 'user.message', 'user_input.completed', 'user_input.requested',
] as const satisfies readonly SessionEvent['type'][];
// Compiles only while the list names every type the SDK declares.
export const everyEventTypeListed: readonly (typeof EVENT_TYPES)[number][] = [] as SessionEvent['type'][];

/**
 * Events the Copilot CLI sends that the SDK does not declare, which the adapter leaves out: the model call's own lifecycle and log. the Copilot
 * runtime 1.0.109 sends them on every turn (native check, `tests/native-assumptions.local.test.ts`, 2026-11-22).
 */
const UNDECLARED_EVENT_TYPES = ['model.call_finished', 'model.call_start', 'model.log', 'model.message', 'model.messages_snapshot', 'model.model_call_started',
  'model.model_call_success', 'model.response', 'model.turn_ended', 'model.turn_started'];

const eventTypes = new Set<string>([...EVENT_TYPES, ...UNDECLARED_EVENT_TYPES]);

/** Whether the adapter knows a session event's type. */
export const knownCopilotEvent = (type: unknown): boolean => typeof type === 'string' && eventTypes.has(type);
