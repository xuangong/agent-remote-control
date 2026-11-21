import { AgentRuntimeError } from '@orchardworks/agent-provider-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withinResumeDeadline } from './resume-deadline.js';

afterEach(() => { vi.useRealTimers(); });

function pendingOpen() {
  let settle!: { resolve(session: { dispose(): Promise<void> }): void; reject(error: unknown): void };
  const open = new Promise<{ dispose(): Promise<void> }>((resolve, reject) => { settle = { resolve, reject }; });
  return { open, settle, session: { dispose: vi.fn(async () => {}) } };
}

describe('the resume deadline', () => {
  it('passes an open that settles before the deadline through, its failure too (RD1)', async () => {
    vi.useFakeTimers();
    const opened = pendingOpen();
    const result = withinResumeDeadline(opened.open, 1000);
    await vi.advanceTimersByTimeAsync(999);
    opened.settle.resolve(opened.session);
    await expect(result).resolves.toBe(opened.session);
    const failed = pendingOpen();
    const failure = withinResumeDeadline(failed.open, 1000);
    failed.settle.reject(new Error('The CLI refused.'));
    await expect(failure).rejects.toThrow('The CLI refused.');
  });

  it('fails native_unresponsive at the deadline, not a millisecond before (RD2)', async () => {
    vi.useFakeTimers();
    const opened = pendingOpen();
    let outcome: unknown;
    withinResumeDeadline(opened.open, 1000).catch(error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(AgentRuntimeError);
    expect((outcome as AgentRuntimeError).code).toBe('native_unresponsive');
  });

  it('closes a session the CLI hands over after the deadline, and drops a late failure (RD3)', async () => {
    vi.useFakeTimers();
    const opened = pendingOpen();
    await Promise.all([withinResumeDeadline(opened.open, 1000).catch(() => undefined), vi.advanceTimersByTimeAsync(1000)]);
    opened.settle.resolve(opened.session);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened.session.dispose).toHaveBeenCalledOnce();
    const failed = pendingOpen();
    await Promise.all([withinResumeDeadline(failed.open, 1000).catch(() => undefined), vi.advanceTimersByTimeAsync(1000)]);
    failed.settle.reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
  });
});
