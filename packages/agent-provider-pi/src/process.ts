import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { piInvocation } from './executable.js';
import { isRecord, type Json } from './native.js';

/** How a pi process ended. */
export interface PiExit { code: number | null; signal: string | null; stderr: string }

/** One pi process in RPC mode: JSON objects in and out, one per line. This is the adapter's native port; a test plays the CLI through it. */
export interface PiChannel {
  send(message: Json): void;
  onMessage(listener: (message: Json) => void): void;
  onExit(listener: (exit: PiExit) => void): void;
  /** Ends the process and resolves once it is gone. */
  stop(): Promise<void>;
}

export interface PiLaunch { args: string[]; cwd: string; env: Record<string, string | undefined> }
export type PiLauncher = (launch: PiLaunch) => PiChannel;

const STDERR_LIMIT = 4096;
const KILL_AFTER_MS = 3000;

/**
 * Starts the pi executable in the launch's directory. RPC mode frames records by LF alone (a generic line reader would also split on
 * U+2028 and U+2029, which are valid inside JSON strings), so the stream is split here.
 */
export function spawnPi(executable: string, options: { killAfterMs?: number } = {}): PiLauncher {
  return ({ args, cwd, env }) => {
    const { command, args: commandArgs } = piInvocation(executable, args);
    const child = spawn(command, commandArgs, { cwd, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const messages: Array<(message: Json) => void> = [];
    const exits: Array<(exit: PiExit) => void> = [];
    let stderr = '';
    let exited: PiExit | undefined;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    const line = (text: string) => {
      const trimmed = text.endsWith('\r') ? text.slice(0, -1) : text;
      if (!trimmed) return;
      let parsed: unknown;
      try { parsed = JSON.parse(trimmed); } catch { return; }
      if (isRecord(parsed)) for (const listener of messages) listener(parsed);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) { const text = buffer.slice(0, end); buffer = buffer.slice(end + 1); line(text); }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT); });
    child.stdin.on('error', () => { /* the exit event reports a closed process */ });
    const finish = (code: number | null, signal: string | null) => {
      if (exited) return;
      buffer += decoder.end(); if (buffer) { line(buffer); buffer = ''; }
      exited = { code, signal, stderr };
      for (const listener of exits) listener(exited);
    };
    child.on('error', error => { stderr = (stderr + String(error.message)).slice(-STDERR_LIMIT); finish(null, null); });
    child.on('close', finish);
    return {
      send: message => { if (exited || !child.stdin.writable) throw new Error('The pi process has ended.'); child.stdin.write(`${JSON.stringify(message)}\n`); },
      onMessage: listener => { messages.push(listener); },
      onExit: listener => { if (exited) listener(exited); else exits.push(listener); },
      stop: () => new Promise<void>(resolve => {
        if (exited) return resolve();
        exits.push(() => { clearTimeout(timer); resolve(); });
        child.stdin.end();
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), options.killAfterMs ?? KILL_AFTER_MS);
        timer.unref?.();
      }),
    };
  };
}
