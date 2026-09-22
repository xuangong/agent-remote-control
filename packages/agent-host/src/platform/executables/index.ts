import { resolveWindowsNativeExecutable } from './windows-native.js';
import { resolveWindowsVscodeExecutable } from './windows-vscode.js';

/** Resolve command shims at the platform boundary, never through a command shell. */
export function resolveNativeExecutable(command: string, npmEntry: string, env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32' ? resolveWindowsNativeExecutable(command, npmEntry, env) : command;
}

export function resolveVscodeExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === 'win32' ? resolveWindowsVscodeExecutable(command, env) : command;
}

export function nativeInvocation(executable: string, args: string[]): [string, string[]] {
  return /\.(?:[cm]?js)$/i.test(executable) ? [process.execPath, [executable, ...args]] : [executable, args];
}
