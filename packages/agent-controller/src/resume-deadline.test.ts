import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import { claudeBehaviour } from '@orchardworks/agent-provider-claude';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentHostRuntime } from './host.js';
import { simulatedCli } from './test-utils/simulated-cli.js';

/**
 * The Controller beside a CLI whose resume hangs, played by the CLI simulator from what an adapter declares (Codex: 90 s per request;
 * Claude Code: a 15 s start-up). The Controller gives a hung resume up at the declared deadline, so the binding is free for the next open
 * instead of held until the CLI answers. Requirements review gap 4 (open item O53 in section 10 of
 * `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md`).
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.useRealTimers(); });

const attach = (runtime: ReturnType<typeof createAgentHostRuntime>, requestId: string) => runtime.control({ requestId, method: 'POST', path: '/remote/attach', sessionId: 'agent-1',
  body: JSON.stringify({ providerId: 'simulated', nativeSessionId: 'thread-1' }) });

describe('a resume that hangs', () => {
  it.each([['Codex through its daemon', codexBehaviour('shared')], ['Claude Code', claudeBehaviour]])(
    'is given up at the deadline %s declares with a typed native_unresponsive, and frees the binding for the next open (gap 4)', async (_name, behaviour) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
      const cli = simulatedCli({ behaviour, sessions: { 'thread-1': ['Hello', 'Hi'] } });
      const runtime = createAgentHostRuntime({ registrations: [cli.registration()] });
      closers.push(async () => { cli.faults.heal(); await runtime.close(); });
      cli.faults.hangResume({ once: true });
      let first: Awaited<ReturnType<typeof attach>> | undefined;
      void attach(runtime, 'first').then(result => { first = result; });
      await vi.advanceTimersByTimeAsync(behaviour.resume.deadlineMs - 1);
      expect(first).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(first?.status).toBe(503);
      expect(JSON.parse(String(first?.body)).code).toBe('native_unresponsive');
      // A failed native start is repeated for 5 s rather than started again (session core C14); the binding itself is free.
      await vi.advanceTimersByTimeAsync(5000);
      let second: Awaited<ReturnType<typeof attach>> | undefined;
      void attach(runtime, 'second').then(result => { second = result; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(second?.status).toBe(200);
      // The hung resume answers once healed; nobody holds what it hands over, so it is closed: one client, the second open's.
      cli.faults.heal();
      await vi.advanceTimersByTimeAsync(0);
      expect(cli.native('thread-1').clients).toBe(1);
    });
});
