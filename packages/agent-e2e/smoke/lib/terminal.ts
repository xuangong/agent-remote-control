// A terminal beside the page: the native CLI of a session the run created, writing one turn and exiting, the way a person's
// terminal would. A terminal is outside our system; each CLI's own rules decide whether its turn runs, and this driver only
// reports what the CLI said. Codex joins the session through the shared daemon (the instance's `agent-remote-controller-dev codex`),
// so Codex orders the page's turns and the terminal's. Claude Code resumes the session's transcript in the instance's workspace, as
// S6a's terminal turns did.
import { spawn } from 'node:child_process';
import { delimiter, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Provider } from './sessions.js';

/**
 * How one try of a terminal turn ended, from the CLI's exit code and error output.
 * - `delivered`: the CLI ran the turn and exited 0.
 * - `turn-busy`: Codex refused because another client's turn runs in the session; Codex takes a new turn once that one ends.
 * - `writer-busy`: Codex refused a separate process because the session is loaded in the shared daemon (Codex's single writer).
 * - `failed`: anything else.
 */
export type TerminalOutcome = 'delivered' | 'turn-busy' | 'writer-busy' | 'failed';

export function terminalOutcome(code: number | null, errorOutput: string): TerminalOutcome {
  if (code === 0) return 'delivered';
  if (/already has an active turn/i.test(errorOutput)) return 'turn-busy';
  if (/already has an active writer/i.test(errorOutput)) return 'writer-busy';
  return 'failed';
}

/** Whether a refused try is tried again: only Codex's turn order refuses for a while, until the other client's turn ends. */
export const triesAgain = (outcome: TerminalOutcome): boolean => outcome === 'turn-busy';

export interface TerminalTry { t: number; ms: number; outcome: TerminalOutcome; code: number | null; reason?: string }

export interface TerminalTurn {
  provider: Provider;
  /** Every try in order; the last one decides. */
  tries: TerminalTry[];
  delivered: boolean;
  /** On the caller's clock: when the first try started and when the last one ended. */
  startedAt: number;
  endedAt: number;
}

/** The variables a native CLI of the instance's sessions sees, as the instance's Controller passes them: no agent, grant or package-manager state. */
const passedVariables = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']);

export function nativeEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) if (value !== undefined && (passedVariables.has(key) || key.startsWith('LC_'))) environment[key] = value;
  const path = (parent.PATH ?? '').split(delimiter).filter(entry => entry && !entry.split(sep).includes('node_modules')).join(delimiter);
  return { ...environment, PATH: path || '/usr/bin:/bin:/usr/sbin:/sbin' };
}

/** The command that runs one turn of a session in a terminal, and the directory it runs in. */
export function terminalCommand(provider: Provider, nativeSessionId: string, prompt: string, places: { checkout: string; workspace: string }): { file: string; args: string[]; cwd: string } {
  if (nativeSessionId.startsWith('-')) throw new Error(`Session id ${nativeSessionId} is not a session id.`);
  // From the checkout, the development command picks this checkout's instance and joins the session through the shared daemon.
  if (provider === 'codex') return { file: 'agent-remote-controller-dev', args: ['codex', 'exec', 'resume', nativeSessionId, prompt], cwd: places.checkout };
  if (provider === 'claude') return { file: 'claude', args: ['--resume', nativeSessionId, '-p', prompt], cwd: places.workspace };
  throw new Error(`No terminal turn for ${provider}.`);
}

interface Exit { code: number | null; errorOutput: string; ms: number }

/** Runs one terminal turn of a session this run created, trying again while Codex's turn order refuses it, until `deadlineMs`. */
export class TerminalDriver {
  constructor(private readonly places: { checkout: string; workspace: string }, private readonly now: () => number = Date.now,
    private readonly run: (command: { file: string; args: string[]; cwd: string }) => Promise<Exit> = runCommand) {}

  async turn(provider: Provider, nativeSessionId: string, prompt: string, { deadlineMs = 180_000, retryMs = 1000 }: { deadlineMs?: number; retryMs?: number } = {}): Promise<TerminalTurn> {
    const command = terminalCommand(provider, nativeSessionId, prompt, this.places);
    const startedAt = this.now();
    const tries: TerminalTry[] = [];
    for (;;) {
      const t = this.now();
      const exit = await this.run(command);
      const outcome = terminalOutcome(exit.code, exit.errorOutput);
      tries.push({ t, ms: exit.ms, outcome, code: exit.code, ...(outcome === 'delivered' ? {} : { reason: lastLine(exit.errorOutput) }) });
      if (!triesAgain(outcome) || this.now() - startedAt > deadlineMs) return { provider, tries, delivered: outcome === 'delivered', startedAt, endedAt: this.now() };
      await delay(retryMs);
    }
  }
}

const lastLine = (text: string): string => text.trim().split('\n').filter(line => line.trim()).at(-1)?.slice(0, 300) ?? '';

function runCommand({ file, args, cwd }: { file: string; args: string[]; cwd: string }): Promise<Exit> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env: nativeEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let errorOutput = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-8000); });
    // A turn that hangs is a result, not a stuck run.
    const timer = setTimeout(() => child.kill('SIGTERM'), 240_000);
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, errorOutput: error.message, ms: Date.now() - started }); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, errorOutput, ms: Date.now() - started }); });
  });
}
