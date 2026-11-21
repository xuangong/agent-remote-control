import type { AgentProviderBehaviour, AgentRuntimeInfo, AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import type { ConformanceOpenAnswer, ProviderConformancePorts, ProviderFaultHarness } from '@orchardworks/agent-provider-sdk/conformance';
import { vi } from 'vitest';

import { createAgentHostRuntime } from '../host.js';
import { NATIVE_START_BACKOFF_MS } from '../native-start-backoff.js';
import { TURN_SILENCE_MS } from '../session-core/turn-watchdog.js';
import { journalOfRun } from './journal-continuity.js';
import { simulatedCli } from './simulated-cli.js';

/**
 * What the provider conformance kit (`@orchardworks/agent-provider-sdk/conformance`) needs of the Controller: the Relay journal's window
 * decision over the rows a real agent manager holds for a recording (part 1), and the Controller's host runtime beside the CLI simulator
 * playing a declaration, on a fake clock (part 2). The kit's checks stay in the SDK; these ports only run them against the real modules.
 */
export const controllerConformancePorts: ProviderConformancePorts = {
  async continuity(recording, opens, order) {
    const journal = await journalOfRun(recording.live, order);
    const outcomes = [];
    for (let open = 0; open < opens; open += 1) outcomes.push(await journal.reread(recording.reread));
    return outcomes;
  },
  faults: faultHarness,
};

const AGENT = 'agent-1';
const SESSION = 'thread-1';
const TURN_MS = 1000;

async function faultHarness(behaviour: AgentProviderBehaviour): Promise<ProviderFaultHarness> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const cli = simulatedCli({ behaviour, sessions: { [SESSION]: ['Hello', 'Hi'] }, turnMs: TURN_MS });
  // The generic registration: the policies under test key on the declaration alone. How a page follows a forked transcript is the
  // divergence policy of the managed stdio directory, tested with it (`transcript-fork.test.ts`).
  const runtime = createAgentHostRuntime({ registrations: [cli.registration()] });
  const events: AgentStreamEvent[] = [];
  const followed = new WeakSet<object>();
  let agent: { snapshot(): { payload: { runtimeInfo: AgentRuntimeInfo } } } | undefined;
  let requests = 0;
  /** The session as an operation of a page acquires it, its events followed from then on. */
  const acquire = async () => {
    const lease = await runtime.acquireSession(AGENT);
    if (!lease) throw new Error('The Controller holds no session to act on.');
    agent = lease.agent;
    if (!followed.has(lease.agent)) {
      followed.add(lease.agent);
      lease.agent.subscribe(event => { if (event.type === 'agent_stream') events.push(event.event); });
    }
    return lease;
  };
  return {
    turnMs: TURN_MS,
    failedStartHoldMs: NATIVE_START_BACKOFF_MS,
    silenceMs: TURN_SILENCE_MS,
    async open(): Promise<ConformanceOpenAnswer> {
      const answer = await runtime.control({ requestId: `open-${++requests}`, method: 'POST', path: '/remote/attach', sessionId: AGENT,
        body: JSON.stringify({ providerId: 'simulated', nativeSessionId: SESSION }) });
      const body = JSON.parse(String(answer.body || '{}')) as Record<string, unknown>;
      return { status: answer.status, ...Object.fromEntries(['code', 'reason', 'retryAfterMs', 'resetsAt'].flatMap(key => body[key] === undefined ? [] : [[key, body[key]]])) };
    },
    async send(text) {
      const lease = await acquire();
      try { await lease.agent.sendMessage(text); } finally { lease.release(); }
    },
    events: () => events,
    runtime: () => agent?.snapshot().payload.runtimeInfo,
    async shown() {
      const lease = await acquire();
      try {
        return lease.agent.fetchTimeline({ requestId: `read-${++requests}`, agentId: AGENT, direction: 'tail', limit: 100 }).payload.entries
          .map(entry => 'text' in entry.item ? entry.item.text : `<${entry.item.type}>`);
      } finally { lease.release(); }
    },
    history: () => cli.native(SESSION).history,
    nativeClients: () => cli.native(SESSION).clients,
    diagnostics: () => cli.diagnostics(),
    advance: async ms => { await vi.advanceTimersByTimeAsync(ms); },
    faults: cli.faults,
    writeElsewhere: ({ text, turnMs, retryAfterMs }) => cli.externalWriter(SESSION, { text, turnMs,
      // Beside shared clients, a writer elsewhere is a process outside them, which a CLI with a single writer refuses or is refused by.
      separate: behaviour.concurrency.model === 'shared_clients', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }),
    async close() {
      cli.faults.heal();
      await runtime.close();
      vi.useRealTimers();
    },
  };
}
