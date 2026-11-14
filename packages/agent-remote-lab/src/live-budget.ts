/** Provisional until stage 6 measures them: conversations kept live beyond those on screen, and how long one stays live after leaving it. */
export const LIVE_RECENT = 4;
export const LIVE_GRACE_MS = 20_000;

export interface LiveBudgetClock { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export interface LiveRegistrationState { visible: boolean; pinned?: boolean; folded?: boolean }
export interface LiveRegistration { update(state: LiveRegistrationState): void; release(): void }

const systemClock: LiveBudgetClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Which of this device's mounted conversations keep a live stream. A conversation is live while it is on screen or has
 * pending input; after leaving the screen it stays live for a grace period, then only while it is among the most recently
 * seen. A folded one (every surface showing it folded) is released at once. An unregistered conversation is not managed
 * and counts as live. The budget is device-local resource management: it never changes what the owner chose to fold or sleep.
 */
export class LiveBudget {
  readonly #recent: number;
  readonly #graceMs: number;
  readonly #clock: LiveBudgetClock;
  readonly #registrations = new Map<string, Set<{ state: LiveRegistrationState }>>();
  readonly #seen = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  #live = new Map<string, boolean>();
  #timer: unknown;
  #version = 0;

  constructor(options: { recent?: number; graceMs?: number; clock?: LiveBudgetClock } = {}) {
    this.#recent = options.recent ?? LIVE_RECENT;
    this.#graceMs = options.graceMs ?? LIVE_GRACE_MS;
    this.#clock = options.clock ?? systemClock;
  }

  /** Changes whenever a conversation becomes live or is released. */
  get version(): number { return this.#version; }

  register(id: string, state: LiveRegistrationState): LiveRegistration {
    const entry = { state };
    const entries = this.#registrations.get(id) ?? new Set();
    this.#registrations.set(id, entries);
    const wasActive = active(entries);
    entries.add(entry);
    this.#mark(id, wasActive);
    this.#recompute();
    return {
      update: next => {
        if (!entries.has(entry) || same(entry.state, next)) return;
        const before = active(entries);
        entry.state = next;
        this.#mark(id, before);
        this.#recompute();
      },
      release: () => {
        const before = active(entries);
        if (!entries.delete(entry)) return;
        if (!entries.size) { this.#registrations.delete(id); this.#seen.delete(id); } else this.#mark(id, before);
        this.#recompute();
      },
    };
  }

  live(id: string): boolean { return this.#live.get(id) ?? true; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** A conversation on screen or with pending input is in use now; one that stops being in use was last used then. */
  #mark(id: string, wasActive: boolean) {
    const entries = this.#registrations.get(id);
    if (entries && (active(entries) || wasActive || !this.#seen.has(id))) this.#seen.set(id, this.#clock.now());
  }

  #recompute() {
    const now = this.#clock.now(), next = new Map<string, boolean>();
    const waiting: Array<{ id: string; seen: number }> = [];
    for (const [id, entries] of this.#registrations) {
      const states = [...entries].map(entry => entry.state);
      if (states.some(state => state.visible || state.pinned)) { next.set(id, true); continue; }
      if (states.every(state => state.folded)) { next.set(id, false); continue; }
      waiting.push({ id, seen: this.#seen.get(id) ?? now });
    }
    waiting.sort((a, b) => b.seen - a.seen);
    let nextDeadline: number | undefined;
    waiting.forEach(({ id, seen }, index) => {
      const graceEnds = seen + this.#graceMs;
      const live = index < this.#recent || now < graceEnds;
      next.set(id, live);
      if (live && index >= this.#recent) nextDeadline = Math.min(nextDeadline ?? graceEnds, graceEnds);
    });
    if (this.#timer !== undefined) { this.#clock.clearTimeout(this.#timer); this.#timer = undefined; }
    if (nextDeadline !== undefined) this.#timer = this.#clock.setTimeout(() => { this.#timer = undefined; this.#recompute(); }, Math.max(0, nextDeadline - now));
    const changed = next.size !== this.#live.size || [...next].some(([id, live]) => this.#live.get(id) !== live);
    this.#live = next;
    if (!changed) return;
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }
}

function active(entries: ReadonlySet<{ state: LiveRegistrationState }>) {
  return [...entries].some(entry => entry.state.visible || entry.state.pinned);
}
function same(a: LiveRegistrationState, b: LiveRegistrationState) {
  return a.visible === b.visible && !!a.pinned === !!b.pinned && !!a.folded === !!b.folded;
}
