import { AgentRuntimeError } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerRpcError } from './app-server-transport.js';

/** Only direct identity lookups establish unavailability; history paging failures do not. */
export function sessionLookupError(error: unknown, nativeSessionId: string, method: 'thread/read' | 'thread/resume'): unknown {
  const expected = method === 'thread/read'
    ? `thread not loaded: ${nativeSessionId}`
    : `no rollout found for thread id ${nativeSessionId}`;
  if (error instanceof CodexAppServerRpcError && error.code === -32600 && error.message === expected) {
    return new AgentRuntimeError('native_session_unavailable',
      'The native runtime could not find this session. Check the Controller log and whether the session is available in the native client.');
  }
  return error;
}
