import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { record } from './projector.js';

/**
 * The kinds of native events the Claude Code adapter knows: it projects each of them or leaves it out on purpose. Any other kind is an
 * event it does not know, which becomes one diagnostic and never a row (gap 10, `agent-provider-sdk/src/native-events.ts`).
 * - Live, the messages of the Agent SDK's stream (0.3.247, `SDKMessage`): the lists name every type and `system` subtype the SDK
 *   declares, which the compiler checks, so an SDK update that adds one fails the build until the adapter decides what it is. A stream
 *   event carries the model API's own events, whose content the record after it repeats.
 * - In history, the records of the transcript as the SDK's session read returns them: user, assistant and system records. Their system
 *   subtypes are the stream's and those Claude Code 2.1 writes only to its transcript, as transcripts of 2.1.3xx hold them.
 */
const MESSAGE_TYPES = ['assistant', 'auth_status', 'conversation_reset', 'prompt_suggestion', 'rate_limit_event', 'result', 'stream_event', 'system',
  'tool_progress', 'tool_use_summary', 'user'] as const satisfies readonly SDKMessage['type'][];
const SYSTEM_SUBTYPES = ['api_retry', 'background_tasks_changed', 'commands_changed', 'compact_boundary', 'control_request_progress', 'elicitation_complete',
  'files_persisted', 'hook_progress', 'hook_response', 'hook_started', 'informational', 'init', 'local_command_output', 'memory_recall', 'mirror_error',
  'model_refusal_fallback', 'model_refusal_no_fallback', 'notification', 'permission_denied', 'plugin_install', 'session_state_changed', 'status',
  'task_notification', 'task_progress', 'task_started', 'task_updated', 'thinking_tokens', 'worker_shutting_down'] as const satisfies readonly Extract<SDKMessage, { type: 'system' }>['subtype'][];
// These compile only while the lists name every kind the SDK declares.
export const everyMessageTypeListed: readonly (typeof MESSAGE_TYPES)[number][] = [] as SDKMessage['type'][];
export const everySystemSubtypeListed: readonly (typeof SYSTEM_SUBTYPES)[number][] = [] as Extract<SDKMessage, { type: 'system' }>['subtype'][];

/** The input lifecycle of queued commands, which the CLI sends outside the SDK's declared union. */
const UNDECLARED_MESSAGE_TYPES = ['command_lifecycle'];
/** System records only the transcript holds: hook and turn summaries, model API errors, away summaries, local commands, scheduled tasks. */
const TRANSCRIPT_SYSTEM_SUBTYPES = ['agents_killed', 'api_error', 'away_summary', 'local_command', 'scheduled_task_fire', 'stop_hook_summary', 'turn_duration'];

const messageTypes = new Set<string>([...MESSAGE_TYPES, ...UNDECLARED_MESSAGE_TYPES]);
const systemSubtypes = new Set<string>(SYSTEM_SUBTYPES);
const recordTypes = new Set<string>(['user', 'assistant', 'system']);
const recordSystemSubtypes = new Set<string>([...SYSTEM_SUBTYPES, ...TRANSCRIPT_SYSTEM_SUBTYPES]);

const kindOf = (value: Record<string, unknown>) => value.type === 'system' ? `system/${String(value.subtype)}` : String(value.type);

/** The kind of a message of the live stream the adapter does not know, or undefined for one it knows. */
export function unknownClaudeMessage(message: unknown): string | undefined {
  if (!record(message) || typeof message.type !== 'string') return '(unreadable)';
  if (!messageTypes.has(message.type)) return kindOf(message);
  return message.type === 'system' && !systemSubtypes.has(String(message.subtype)) ? kindOf(message) : undefined;
}

/** The kind of a transcript record the adapter does not know, or undefined for one it knows. */
export function unknownClaudeRecord(value: unknown): string | undefined {
  if (!record(value) || typeof value.type !== 'string') return '(unreadable)';
  if (!recordTypes.has(value.type)) return kindOf(value);
  return value.type === 'system' && value.subtype !== undefined && !recordSystemSubtypes.has(String(value.subtype)) ? kindOf(value) : undefined;
}
