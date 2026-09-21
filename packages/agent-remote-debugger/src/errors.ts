import type { RemoteOperationError } from '@orchardworks/agent-remote-web/headless';

export class DebuggerError extends Error {
  readonly name = 'DebuggerError';

  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
  }
}

export function remoteOperationFailure(error: RemoteOperationError): DebuggerError {
  const exitCode = error.code === 'operation_timeout'
    ? 5
    : error.code === 'network_error' || error.code === 'connection_disconnected'
      || error.code === 'operation_send_failed' || error.code === 'operation_stopped'
      ? 3
      : 4;
  return new DebuggerError(exitCode, error.code, error.message, error.recoverable);
}
