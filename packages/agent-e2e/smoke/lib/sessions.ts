import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);

export type Provider = 'claude' | 'codex' | 'copilot';

export interface OwnSession { address: string; provider: Provider; released: boolean }

/** Deadlines in milliseconds that the harness applies to one real model turn. */
export const TURN_DEADLINE_MS = 180_000;

/**
 * The sessions of one smoke run, created and driven through the instance's development command. Only sessions created here are
 * ever read, sent to or released; Codex sessions are released at the end because they stay loaded in the user's shared daemon.
 */
export class SessionPool {
  readonly sessions: OwnSession[] = [];
  constructor(private readonly checkout: string, private readonly log: (message: string) => void = () => {}) {}

  /** Runs one development-command call and parses its JSON. Failures carry the error code the command printed. */
  async command(...args: string[]): Promise<any> {
    try {
      const { stdout } = await run('agent-remote-controller-dev', args, { cwd: this.checkout, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      let code: string | undefined;
      try { code = JSON.parse(failure.stdout ?? '').error?.code; } catch { code = undefined; }
      throw Object.assign(new Error(`agent-remote-controller-dev ${args.slice(0, 2).join(' ')} failed: ${(failure.stdout || failure.stderr || failure.message).slice(0, 400)}`), { code });
    }
  }

  /** Creates a session with its first message and returns its address. The session is recorded for release. */
  async create(provider: Provider, message: string): Promise<string> {
    const created = await this.command('session', 'create', '--provider', provider, '--message', message);
    const address = String(created.session.address);
    this.sessions.push({ address, provider, released: false });
    this.log(`created ${provider} session ${address}`);
    return address;
  }

  async send(address: string, text: string): Promise<void> {
    this.assertOwn(address);
    await this.command('session', 'send', address, text);
  }

  async link(address: string): Promise<string> {
    this.assertOwn(address);
    return String((await this.command('session', 'link', address)).url);
  }

  /** The newest entries and the session state. A session with no history yet reads as `history_unavailable`: that is empty here. */
  async read(address: string, limit = 3): Promise<{ state?: string; entries: Array<{ id: string; role: string; text: string }> }> {
    this.assertOwn(address);
    try {
      const read = await this.command('session', 'read', address, '--limit', String(limit));
      return { state: read.session?.state, entries: read.entries ?? [] };
    } catch (error) {
      if ((error as { code?: string }).code === 'history_unavailable') return { entries: [] };
      throw error;
    }
  }

  /** Waits until a new assistant entry exists after `previous` and the session no longer runs. */
  async waitForReply(address: string, previous: string | undefined, deadlineMs = TURN_DEADLINE_MS): Promise<string> {
    const until = Date.now() + deadlineMs;
    for (;;) {
      const { state, entries } = await this.read(address, 1);
      if (state === 'waiting' || state === 'failed') throw new Error(`session ${address} is ${state}`);
      const [newest] = entries;
      if (newest && newest.id !== previous && newest.role === 'assistant' && state !== 'running') return newest.text;
      if (Date.now() > until) throw new Error(`no reply within ${Math.round(deadlineMs / 1000)} s in ${address} (state ${state})`);
      await delay(1500);
    }
  }

  async newestEntryId(address: string): Promise<string | undefined> { return (await this.read(address, 1)).entries[0]?.id; }

  /** Sends a turn and waits for its reply; returns the reply text. */
  async turn(address: string, text: string): Promise<string> {
    const previous = await this.newestEntryId(address);
    await this.send(address, text);
    return this.waitForReply(address, previous);
  }

  /** Releases one Codex session this run created, so the user's shared daemon may unload it; again after a page opened it again. */
  async release(address: string): Promise<void> {
    this.assertOwn(address);
    const session = this.sessions.find(item => item.address === address)!;
    if (session.provider !== 'codex') return;
    await this.command('session', 'release', address);
    session.released = true;
    this.log(`released ${address}`);
  }

  /** Releases every Codex session this run created. Safe to call twice. */
  async releaseAll(): Promise<void> {
    for (const session of this.sessions) {
      if (session.provider !== 'codex' || session.released) continue;
      try { await this.command('session', 'release', session.address); session.released = true; this.log(`released ${session.address}`); }
      catch (error) { this.log(`release of ${session.address} failed: ${(error as Error).message}`); }
    }
  }

  /** Sessions the instance reports as running or waiting that this run did not create: a restart would interrupt them. */
  async foreignActiveSessions(): Promise<string[]> {
    const listed = await this.command('session', 'list', '--limit', '50');
    const own = new Set(this.sessions.map(session => session.address));
    return (listed.sessions as Array<{ address: string; state: string }>).filter(item => (item.state === 'running' || item.state === 'waiting') && !own.has(item.address)).map(item => item.address);
  }

  private assertOwn(address: string): void {
    if (!this.sessions.some(session => session.address === address)) throw new Error(`${address} was not created by this run; the harness only drives its own sessions.`);
  }
}
