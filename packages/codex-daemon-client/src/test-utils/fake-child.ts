import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface FakeChildProcess extends ChildProcessWithoutNullStreams {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  emitExit(code?: number | null, signal?: NodeJS.Signals | null): void;
}

export function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      child.killed = true;
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    },
    emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
    },
  });
  return child;
}
