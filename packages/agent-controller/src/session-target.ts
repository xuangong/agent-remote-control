import { CliError, usage } from './command-output.js';

/**
 * Names the session `session link` is about when the command line gives no address: the calling session itself, the newest
 * session of a provider in the current directory (`--here`), or the one the person picks from that directory's recent
 * sessions (`--pick`). The Controller's session list answers; nothing here reads a provider's files.
 */
export interface LinkTargetRequest { here?: boolean; pick?: boolean; providerId?: string }

export interface TargetTerminal {
  /** Whether a person can answer here: standard input and error are terminals. */
  readonly interactive: boolean;
  /** Shows the numbered lines and returns the number the person typed, or undefined when they gave none. */
  choose(lines: readonly string[]): Promise<number | undefined>;
  /** A progress line beside the JSON result. */
  note(text: string): void;
}

export interface TargetPorts {
  /** Sends one session command to the Controller and returns its result; a failure throws. */
  call(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  terminal?: TargetTerminal;
  now?(): number;
}

interface ListedSession { address: string; providerId: string; title: string; updatedAt: string }
const RECENT = 9;

/** What a native CLI's shell says about the session it runs: Claude Code sets `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID`. */
export function inferNativeSession(env: NodeJS.ProcessEnv): { providerId: string; nativeSessionId?: string } | undefined {
  if (env.CLAUDECODE !== '1') return undefined;
  const id = env.CLAUDE_CODE_SESSION_ID;
  return { providerId: 'claude', ...(id && /^[A-Za-z0-9_-]{8,128}$/.test(id) ? { nativeSessionId: id } : {}) };
}

/** Why a provider may have no session in a directory, in words that say what to do. */
function nothingHere(providerId: string, cwd: string): CliError {
  const hint: Record<string, string> = {
    pi: 'pi saves a session only after its first message: send one, then run this again.',
    claude: 'Claude Code saves a session when its first message is sent: send one, then run this again.',
    codex: 'Codex was asked to list its sessions and none has this working directory.',
    copilot: 'Copilot lists the sessions it has saved: send a message first, then run this again.',
    opencode: 'OpenCode lists the sessions its server holds: send a message first, then run this again.',
  };
  return new CliError('session_not_found', `No ${providerId} session has ${cwd} as its working directory. ${hint[providerId] ?? ''}`.trim());
}

async function listHere(ports: TargetPorts, providerId: string | undefined, limit: number): Promise<ListedSession[]> {
  const ask = async (refresh: boolean) => {
    const result = await ports.call({ command: 'list', cwd: ports.cwd, limit, ...(providerId ? { providerId } : {}), ...(refresh ? { refresh: true } : {}) });
    if (providerId && Array.isArray(result.unavailableProviders) && result.unavailableProviders.includes(providerId)) {
      throw new CliError('provider_unavailable', `The ${providerId} catalog could not be read on this Host; try again, or check agent-remote-controller status.`);
    }
    return (result.sessions ?? []) as ListedSession[];
  };
  const found = await ask(false);
  // Codex lists sessions started outside the Controller only when asked, which can take a while.
  if (found.length || providerId !== 'codex') return found;
  ports.terminal?.note('Asking Codex to list its sessions…');
  return ask(true);
}

function ago(updatedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(updatedAt)) / 1000));
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

export async function resolveLinkTarget(request: LinkTargetRequest, ports: TargetPorts): Promise<string> {
  if (!request.here && !request.pick) {
    if (ports.env.AGENT_REMOTE_SESSION_TOKEN) return 'self';
    return usage('Name the session as <hostId>/<providerId>/<nativeSessionId>, or use --here or --pick in the directory it works in.');
  }
  const native = inferNativeSession(ports.env);
  if (request.here) {
    const providerId = request.providerId ?? native?.providerId
      ?? usage('Name the provider with --provider (claude, codex, copilot, opencode or pi); only Claude Code tells its shell which session it runs.');
    // Claude Code names its own session: that one, not merely the newest of the directory.
    if (native?.providerId === providerId && native.nativeSessionId) {
      const address = `local/${providerId}/${native.nativeSessionId}`;
      try { await ports.call({ command: 'read', target: address, limit: 0 }); return address; }
      catch (error) { if ((error as { code?: string }).code === 'session_not_found') throw nothingHere(providerId, ports.cwd); throw error; }
    }
    const [newest] = await listHere(ports, providerId, 1);
    if (!newest) throw nothingHere(providerId, ports.cwd);
    return newest.address;
  }
  const sessions = (await listHere(ports, request.providerId, RECENT));
  if (!sessions.length) throw nothingHere(request.providerId ?? 'native', ports.cwd);
  const now = (ports.now ?? Date.now)();
  const lines = sessions.map((session, index) => `${index + 1}. ${session.title || '(untitled)'}  [${session.providerId}]  ${ago(session.updatedAt, now)}`);
  if (!ports.terminal?.interactive) {
    throw new CliError('selection_needed', `Choose a session by its address; this is not a terminal.\n${lines.join('\n')}`,
      { sessions: sessions.map(session => ({ address: session.address, providerId: session.providerId, title: session.title, updatedAt: session.updatedAt })) });
  }
  const chosen = await ports.terminal.choose(lines);
  if (chosen === undefined || !Number.isInteger(chosen) || chosen < 1 || chosen > sessions.length) throw new CliError('canceled', 'No session was chosen.');
  return sessions[chosen - 1]!.address;
}
