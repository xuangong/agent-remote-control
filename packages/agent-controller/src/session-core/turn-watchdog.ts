import type { AgentRuntimeInfo, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';

import type { DeadlineTimers } from './resume-deadline.js';

/**
 * Turn watchdog: for an adapter that declares no heartbeat of its own (`behaviour.turn.heartbeatMs`), a turn whose CLI says nothing for
 * `TURN_SILENCE_MS` is taken for a CLI that stopped answering. The turn ends for its readers as failed, typed `native_unresponsive`, the
 * session reads idle, and the runtime is released, so the next send attaches the session again from native history. Keyed on the
 * declared behaviour, never on a provider id.
 *
 * Contract.
 * - W1 The watch starts when a turn starts (`turn_started`, or a `runtime_updated` naming an active turn), restarts with every item the
 *   session emits, and stops when the turn ends (completed, failed, canceled, or no active turn).
 * - W2 At `silenceMs` of silence it emits `turn_failed` for the running turn with code `native_unresponsive` and fixed words, then the
 *   last runtime state it saw as idle with no active turn, once per turn, and calls `unresponsive`. The CLI's own items keep flowing until
 *   the session ends.
 * - W3 Limit: a command that runs silently for longer than `TURN_SILENCE_MS` is taken for a hang (Claude Code stops a Bash command at
 *   10 minutes).
 *
 * Ports: the timers, the global ones by default, so fake timers drive the watch.
 */
export const TURN_SILENCE_MS = 15 * 60_000;
export const TURN_UNRESPONSIVE_MESSAGE = 'The native CLI stopped answering during this turn.';

const globalTimers: DeadlineTimers = { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };

export function watchTurns(session: AgentSession, options: { silenceMs: number; unresponsive(): void; timers?: DeadlineTimers; now?: () => number }): AgentSession {
  const timers = options.timers ?? globalTimers;
  const now = options.now ?? Date.now;
  async function* observe(): AsyncGenerator<ProviderStreamItem> {
    const source = session.observe()[Symbol.asyncIterator]();
    let turn: { id: string | undefined } | undefined;
    let provider: string | undefined;
    let runtimeInfo: AgentRuntimeInfo | undefined;
    let next: Promise<IteratorResult<ProviderStreamItem>> | undefined;
    let fired = 0;
    try {
      for (;;) {
        next ??= source.next();
        let timer: unknown;
        const silence = turn ? new Promise<'silent'>(resolve => { timer = timers.setTimeout(() => resolve('silent'), options.silenceMs); }) : undefined;
        const result = silence ? await Promise.race([next, silence]) : await next;
        if (timer !== undefined) timers.clearTimeout(timer);
        if (result === 'silent') {
          const at = now(), turnId = turn!.id;
          turn = undefined;
          fired += 1;
          const key = `controller-watchdog:${at}:${fired}`;
          yield { type: 'observation', sourceKey: `${key}:failed`, occurredAt: at, delivery: 'live',
            event: { type: 'turn_failed', provider: provider ?? '', error: TURN_UNRESPONSIVE_MESSAGE, code: 'native_unresponsive', ...(turnId === undefined ? {} : { turnId }) } };
          if (runtimeInfo) yield { type: 'observation', sourceKey: `${key}:idle`, occurredAt: at, delivery: 'live',
            event: { type: 'runtime_updated', provider: provider ?? runtimeInfo.providerId, runtimeInfo: { ...runtimeInfo, status: 'idle' }, activeTurnId: null } };
          options.unresponsive();
          continue;
        }
        next = undefined;
        if (result.done) return;
        const item = result.value;
        if (item.type === 'observation') {
          const event = item.event;
          provider = event.provider;
          if (event.type === 'turn_started') turn = { id: event.turnId };
          else if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_canceled') turn = undefined;
          else if (event.type === 'runtime_updated') {
            runtimeInfo = event.runtimeInfo;
            if (event.activeTurnId === null) turn = undefined;
            else if (event.activeTurnId !== undefined) turn ??= { id: event.activeTurnId };
          }
        }
        yield item;
      }
    } finally { await source.return?.(); }
  }
  return new Proxy(session, { get(target, key) {
    if (key === 'observe') return observe;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
