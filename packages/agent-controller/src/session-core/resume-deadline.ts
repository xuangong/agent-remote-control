import { AgentRuntimeError } from '@orchardworks/agent-provider-sdk';

/**
 * Resume deadline: a resume the CLI does not answer within the deadline its adapter declares (`behaviour.resume.deadlineMs`, with its
 * cost class) is given up, so it frees the session's binding instead of holding it until the CLI answers, and the next open tries again.
 * Keyed on the declared behaviour, never on a provider id.
 *
 * Contract.
 * - RD1 An open that settles before the deadline passes through unchanged, its failure too.
 * - RD2 At the deadline the open fails with the typed `native_unresponsive`, whatever the CLI does later.
 * - RD3 A session the CLI hands over after the deadline is disposed at once, since nobody holds it; a late failure is dropped.
 *
 * Ports: the timers, the global ones by default, so fake timers drive the deadline.
 */
export const RESUME_UNRESPONSIVE_MESSAGE = 'The native CLI did not answer the resume of this session before its deadline.';

export interface DeadlineTimers { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void }
const globalTimers: DeadlineTimers = { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };

export function withinResumeDeadline<T extends { dispose(): Promise<void> }>(open: Promise<T>, deadlineMs: number, timers: DeadlineTimers = globalTimers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let late = false;
    const timer = timers.setTimeout(() => {
      late = true;
      reject(new AgentRuntimeError('native_unresponsive', RESUME_UNRESPONSIVE_MESSAGE));
    }, deadlineMs);
    open.then(session => {
      if (late) { void session.dispose().catch(() => undefined); return; }
      timers.clearTimeout(timer);
      resolve(session);
    }, error => {
      if (late) return;
      timers.clearTimeout(timer);
      reject(error);
    });
  });
}
