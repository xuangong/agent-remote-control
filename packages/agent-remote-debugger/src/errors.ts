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
