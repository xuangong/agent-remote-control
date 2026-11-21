import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentHostRuntime } from './host.js';
import { simulatedCli } from './test-utils/simulated-cli.js';

/**
 * The Controller beside a CLI whose resume hangs, played by the CLI simulator from what the Codex adapter declares (a 90 s deadline per
 * request). Nothing on the Controller's side gives up a hung resume today: it holds the session's binding until the CLI answers, so every
 * later open waits behind it. Requirements review gap 4 (open item O53 in section 10 of
 * `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md`).
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

const behaviour = codexBehaviour('shared');
const attach = (runtime: ReturnType<typeof createAgentHostRuntime>, requestId: string) => runtime.control({ requestId, method: 'POST', path: '/remote/attach', sessionId: 'agent-1',
  body: JSON.stringify({ providerId: 'simulated', nativeSessionId: 'thread-1' }) });

describe('a resume that hangs', () => {
  it.fails('is given up at the declared deadline with a typed timeout, and frees the binding for the next open (gap 4)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    const cli = simulatedCli({ behaviour, sessions: { 'thread-1': ['Hello', 'Hi'] } });
    const runtime = createAgentHostRuntime({ registrations: [cli.registration()] });
    closers.push(async () => { cli.faults.heal(); await runtime.close(); });
    cli.faults.hangResume({ once: true });
    let first: Awaited<ReturnType<typeof attach>> | undefined;
    void attach(runtime, 'first').then(result => { first = result; });
    await vi.advanceTimersByTimeAsync(behaviour.resume.deadlineMs);
    expect(first?.status).toBe(503);
    expect(JSON.parse(String(first?.body)).code).toBe('native_resume_timeout');
    let second: Awaited<ReturnType<typeof attach>> | undefined;
    void attach(runtime, 'second').then(result => { second = result; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(second?.status).toBe(200);
  });
});
