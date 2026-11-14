import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import { isOutboxPoll, type OutboxDelivery, type OutboxHostCall } from '@orchardworks/agent-remote-protocol';
import { OperationCacheError, type RemoteHostSessionLease } from '@orchardworks/agent-remote-relay';
import { availableDelivery } from './team.js';

/** A native session on this Host. */
export interface OutboxTarget { providerId: string; nativeSessionId: string }
export interface OutboxAccess {
  available(): boolean;
  /** The session that carries a conversation now, following its successions. */
  route(session: OutboxTarget): OutboxTarget;
  acquire(providerId: string, nativeSessionId: string): Promise<RemoteHostSessionLease>;
}
export interface SessionOutboxOptions {
  /** Where receipts of claimed messages are kept, so a restart never sends one twice. */
  file: string;
  access: OutboxAccess;
  request(call: OutboxHostCall): Promise<unknown>;
  /** How often to look for messages besides when the Relay says one arrived. */
  intervalMs?: number;
}
type Receipt = { status: 'dispatching' | 'accepted' | 'rejected' | 'unknown'; error?: string };

const RESTARTED = 'The Controller restarted while delivering this message. Check the conversation before sending it again.';
const reason = (error: unknown) => (error instanceof Error && error.message.trim() ? error.message.trim() : 'The session did not take the message.').slice(0, 512);
const refused = (error: unknown) => error instanceof AgentOperationRejectedError
  || error instanceof OperationCacheError && !['operation_outcome_unknown', 'native_file_limit'].includes(error.code);
/** The Relay refused a claim because the message is no longer waiting (cancelled, or claimed before). */
const gone = (error: unknown) => {
  const status = (error as { status?: unknown })?.status;
  return status === 404 || status === 409;
};

/**
 * Delivers the messages that waited on the Relay for this Host while it was offline. Each pass polls the Host's
 * messages; for each one whose session can take input now it claims it, writes a receipt, sends the text as a new turn
 * (or as the next turn while one runs) and settles the outcome. A receipt is written before sending, so a message whose
 * send may have happened is settled unknown after a restart, never sent again; a settlement whose answer was lost is
 * repeated from its receipt.
 */
export class SessionOutbox {
  private receipts: Record<string, Receipt> = {};
  private loaded?: Promise<void>;
  private available = false;
  private closed = false;
  private running?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setInterval>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionOutboxOptions) {}

  /** Whether the Relay acknowledged the outbox on the current connection. */
  setAvailable(available: boolean): void {
    if (this.closed) return;
    this.available = available;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (!available) return;
    this.timer = setInterval(() => this.wake(), this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
    this.wake();
  }

  /** Looks for messages now: the Relay said one arrived, or the connection registered. */
  wake(): void {
    if (this.closed || !this.available) return;
    if (this.running) { this.again = true; return; }
    this.running = (async () => {
      try { do { this.again = false; await this.pass(); } while (this.again && !this.closed && this.available); }
      finally { this.running = undefined; }
    })();
  }

  /** Resolves once no pass is running. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
    await this.writes;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.idle();
  }

  private async pass(): Promise<void> {
    await (this.loaded ??= this.load());
    let poll: unknown;
    try { poll = await this.options.request({ action: 'poll' }); } catch { return; }
    if (!isOutboxPoll(poll)) return;
    for (const entry of poll.entries) {
      if (this.closed || !this.available || !this.options.access.available()) return;
      try { await (entry.status === 'delivering' ? this.resettle(entry) : this.deliver(entry)); }
      catch { /* Receipts keep what is known; the next pass continues. */ }
    }
  }

  /** A message this Host claimed before: settle what its receipt says, or unknown when its send may have happened. */
  private async resettle(entry: OutboxDelivery): Promise<void> {
    const receipt = this.receipts[entry.id];
    if (!receipt || receipt.status === 'dispatching') await this.record(entry.id, { status: 'unknown', error: RESTARTED });
    await this.settle(entry.id);
  }

  private async deliver(entry: OutboxDelivery): Promise<void> {
    // A receipt for a waiting message is from before the owner sent it again.
    if (this.receipts[entry.id]) await this.record(entry.id, undefined);
    let target: OutboxTarget = { providerId: entry.providerId, nativeSessionId: entry.nativeSessionId };
    try { target = this.options.access.route(target); } catch { /* A session without successions carries its own conversation. */ }
    let lease: RemoteHostSessionLease;
    try { lease = await this.options.access.acquire(target.providerId, target.nativeSessionId); }
    catch (error) {
      // The session cannot be opened on this Host: the owner learns why instead of waiting.
      if (!await this.claim(entry.id)) return;
      await this.record(entry.id, { status: 'rejected', error: reason(error) });
      await this.settle(entry.id);
      return;
    }
    try {
      // A new turn when idle, the next turn while one runs; never steered into a running turn.
      const delivery = availableDelivery(lease, false);
      if (!delivery || !await this.claim(entry.id)) return;
      await this.record(entry.id, { status: 'dispatching' });
      let outcome: Receipt;
      try { await lease.agent.sendMessage(entry.text, { delivery }); outcome = { status: 'accepted' }; }
      catch (error) { outcome = { status: refused(error) ? 'rejected' : 'unknown', error: reason(error) }; }
      await this.record(entry.id, outcome);
      await this.settle(entry.id);
    } finally { lease.release(); }
  }

  private async claim(id: string): Promise<boolean> {
    try { await this.options.request({ action: 'claim', id }); return true; }
    catch (error) { if (gone(error)) return false; throw error; }
  }

  private async settle(id: string): Promise<void> {
    const receipt = this.receipts[id];
    if (!receipt || receipt.status === 'dispatching') return;
    await this.options.request({ action: 'settle', id, outcome: receipt.status, ...(receipt.error ? { error: receipt.error } : {}) });
    await this.record(id, undefined);
  }

  private async record(id: string, receipt: Receipt | undefined): Promise<void> {
    if (receipt) this.receipts[id] = receipt; else delete this.receipts[id];
    const contents = JSON.stringify({ version: 1, receipts: this.receipts });
    const write = this.writes.then(async () => {
      const temporary = `${this.options.file}.${process.pid}.tmp`;
      await mkdir(dirname(this.options.file), { recursive: true });
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.options.file);
    });
    // A receipt that cannot be written stops this delivery before its send.
    this.writes = write.catch(() => undefined);
    await write;
  }

  private async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.options.file, 'utf8')) as { version?: unknown; receipts?: unknown };
      if (value?.version !== 1 || !value.receipts || typeof value.receipts !== 'object') return;
      for (const [id, receipt] of Object.entries(value.receipts as Record<string, Receipt>)) {
        if (receipt && ['dispatching', 'accepted', 'rejected', 'unknown'].includes(receipt.status)) this.receipts[id] = { status: receipt.status, ...(typeof receipt.error === 'string' ? { error: receipt.error.slice(0, 512) } : {}) };
      }
    } catch { /* No receipts: a claimed message is settled unknown, never sent again. */ }
  }
}
