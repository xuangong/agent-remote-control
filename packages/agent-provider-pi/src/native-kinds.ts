/**
 * The kinds of record the adapter knows, written against pi 0.73.1 (`docs/rpc.md`, `docs/session-format.md`): it projects each of them
 * or leaves it out on purpose. A kind of any other name is one the adapter does not know, which becomes one diagnostic and never a
 * row (gap 10, `agent-provider-sdk/src/native-events.ts`).
 */
const EVENT_TYPES = ['agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'queue_update', 'compaction_start', 'compaction_end',
  'auto_retry_start', 'auto_retry_end', 'extension_error'] as const;
const ENTRY_TYPES = ['session', 'message', 'model_change', 'thinking_level_change', 'compaction', 'branch_summary', 'custom', 'custom_message', 'label', 'session_info'] as const;
const MESSAGE_ROLES = ['user', 'assistant', 'toolResult', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary'] as const;

const events = new Set<string>(EVENT_TYPES);
const entries = new Set<string>(ENTRY_TYPES);
const roles = new Set<string>(MESSAGE_ROLES);

/** Whether the adapter knows an RPC event type. */
export const knownPiEvent = (type: unknown): boolean => typeof type === 'string' && events.has(type);
/** Whether the adapter knows a session file entry type. */
export const knownPiEntry = (type: unknown): boolean => typeof type === 'string' && entries.has(type);
/** Whether the adapter knows a message role. */
export const knownPiRole = (role: unknown): boolean => typeof role === 'string' && roles.has(role);
