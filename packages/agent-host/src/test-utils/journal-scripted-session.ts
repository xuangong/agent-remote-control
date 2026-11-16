import type { AgentCapabilities, AgentResourceReadResult, AgentRuntimeInfo, AgentSession, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { AgentManager } from '@orchardworks/agent-remote-relay';

const capabilities: AgentCapabilities = {
  history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: true, planApproval: true, toolApproval: true },
};

export interface OlderPage { observations: ProviderObservation[]; nextCursor?: string }

/** A provider session a test drives: queued items, then live items pushed later, and older pages read on request. */
export class ScriptedSession implements AgentSession {
  readonly capabilities: AgentCapabilities;
  readonly sent: string[] = [];
  private readonly queue: ProviderStreamItem[];
  private waiter: ((item: ProviderStreamItem | undefined) => void) | undefined;
  private disposed = false;
  readonly readTimelineHistory?: AgentSession['readTimelineHistory'];
  readonly readResource?: (locator: string) => Promise<AgentResourceReadResult>;

  /** `resources` are the files the session can read, by locator; with any, the session says it can read resources. */
  constructor(readonly providerId: string, readonly nativeSessionId: string, initial: ProviderStreamItem[], older?: OlderPage[], resources?: Record<string, Uint8Array>) {
    this.capabilities = { ...capabilities, ...(resources ? { readResource: true } : {}) };
    if (resources) this.readResource = async locator => resources[locator] ? { status: 'available', bytes: resources[locator]!, mediaType: 'image/png' } : { status: 'unavailable', reason: 'No such file.' };
    this.queue = [...initial];
    if (older) {
      const pages = [...older];
      this.readTimelineHistory = async () => pages.shift() ?? { observations: [] };
    }
  }

  async *observe(): AsyncIterable<ProviderStreamItem> {
    while (true) {
      const item = this.queue.shift() ?? await new Promise<ProviderStreamItem | undefined>(resolve => { if (this.disposed) resolve(undefined); else this.waiter = resolve; });
      if (!item) return;
      yield item;
    }
  }

  push(item: ProviderStreamItem): void {
    const waiter = this.waiter;
    if (waiter) { this.waiter = undefined; waiter(item); } else this.queue.push(item);
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return { providerId: this.providerId, sessionId: this.nativeSessionId, status: 'idle', persistence: { providerId: this.providerId, sessionId: this.nativeSessionId, opaque: '{}' } };
  }
  async sendMessage(text: string): Promise<void> { this.sent.push(text); }
  async respondToInteraction(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(undefined);
  }
}

let sequence = 0;

/** A timeline observation of one item. `completes` ends the item; history rows always complete their item. */
export function item(delivery: 'history' | 'live', key: string, text: string, options: { completes?: boolean; liveOnly?: boolean; type?: 'assistant_message' | 'user_message'; sourceKey?: string; turnId?: string } = {}): ProviderObservation {
  sequence += 1;
  const completes = options.completes ?? delivery === 'history';
  return {
    type: 'observation', sourceKey: options.sourceKey ?? `${delivery}:${key}:${sequence}`, occurredAt: 1_725_000_000_000 + sequence, delivery,
    event: { type: 'timeline', provider: 'fake', turnId: options.turnId ?? 'turn-1', item: { type: options.type ?? 'assistant_message', text, messageId: key } },
    itemIdentity: { key, ...(completes ? { completes: true as const } : {}), ...(options.liveOnly ? { liveOnly: true as const } : {}) },
  };
}

export const boundary = (olderCursor?: string): ProviderStreamItem => ({ type: 'history_boundary', ...(olderCursor === undefined ? {} : { olderCursor }) });

/** An agent manager over a scripted session, ready after its history boundary. It checks the identity contract, as the manager of a journal-capable provider does. */
export async function attachScripted(session: ScriptedSession, agentId = 'agent-1', options: { resourceIdKey?: string } = {}): Promise<AgentManager> {
  const manager = await AgentManager.attach({ agentId, provider: { providerId: session.providerId, displayName: 'Fake' }, epoch: `epoch-${agentId}`, session, journalContract: true, ...(options.resourceIdKey === undefined ? {} : { resourceIdKey: options.resourceIdKey }) });
  await manager.ready;
  return manager;
}

/**
 * A clock a test moves by hand, handed to the publisher as its scheduler and its `now`. Timers fire in order as it advances,
 * so every timing behaviour of the publisher is exercised without waiting.
 */
export function virtualClock(start = 1_000_000) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    now: (): number => now,
    setTimeout(callback: () => void, delayMs: number): unknown {
      const id = ++nextId;
      timers.set(id, { at: now + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimeout(timer: unknown): void { timers.delete(timer as number); },
    advance(ms: number): void {
      const target = now + ms;
      while (true) {
        let due: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = target;
    },
    pending: (): number => timers.size,
  };
  return clock;
}

export type VirtualClock = ReturnType<typeof virtualClock>;

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Lets work that runs on the event loop (digests, the loopback's hand-offs) finish while the clock moves a step at a time.
 * `until` polls a condition; `settle` lets a stretch of virtual time pass. Neither waits on the wall clock.
 */
export function driver(clock: VirtualClock, stepMs = 5) {
  return {
    async settle(ms = 30): Promise<void> {
      for (let spent = 0; spent < ms; spent += stepMs) { for (let at = 0; at < 3; at += 1) await tick(); clock.advance(stepMs); }
      for (let at = 0; at < 3; at += 1) await tick();
    },
    async until(check: () => boolean | Promise<boolean>, label: string, virtualMs = 20_000): Promise<void> {
      for (let spent = 0; spent <= virtualMs; spent += stepMs) {
        if (await check()) return;
        await tick();
        clock.advance(stepMs);
      }
      throw new Error(`Timed out waiting for ${label}.`);
    },
  };
}

/**
 * Polls on the wall clock until the check passes, for tests whose other side is a real transport (a socket, a timer of the Host)
 * that no virtual clock drives. The deadline bounds it, and a failure names what never happened.
 */
export async function untilReal(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
