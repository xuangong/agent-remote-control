import { describe, expect, it } from 'vitest';
import type { AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { createAttachmentLedger } from './attachment-ledger.js';
import { createSuccessionWiring } from './succession-wiring.js';
import { WORKER_NAMESPACE } from '../bot-tools.js';

const namespace = (name: string, deferred = false): AgentSessionToolNamespace => ({ name, description: name, deferred, tools: [] });

/** One bound session of a provider with the given tool declaration, and what the Host says its role and bot tools are. */
function fixture(options: { capability: 'live' | 'creation' | 'attachment'; tools: 'none' | 'tasks'; role?: { toolNamespaces?: AgentSessionToolNamespace[] } }) {
  const updates: AgentSessionToolNamespace[][] = [];
  const ledger = createAttachmentLedger();
  const session = { updateToolNamespaces: async (namespaces: AgentSessionToolNamespace[]) => { updates.push([...namespaces]); } };
  const agent = { agentId: 'agent-1' };
  ledger.recordAttachment?.(agent as never, { session } as never);
  const state = { tools: options.tools, role: options.role };
  const ctx = {
    workerSupport: { tools: () => state.tools, namespace: () => namespace(WORKER_NAMESPACE) },
    sessions: { all: () => [{ agentId: 'agent-1', providerId: 'p', nativeSessionId: 'n' }] },
    liveAgent: () => agent,
    ledger: { attachmentOf: () => ({ session }), workerToolsApplied: ledger.workerToolsApplied, recordWorkerTools: ledger.recordWorkerTools },
    nativeRef: (binding: { providerId: string; nativeSessionId: string }) => ({ controllerId: 'c', ...binding }),
    providers: { require: () => ({ adapter: { descriptor: { sessionExtensions: { tools: true, toolNamespaces: options.capability } } } }) },
    roles: { extensions: async () => state.role },
  };
  const wiring = createSuccessionWiring(ctx as never);
  return { wiring, updates, state, ledger };
}

describe('applying worker tools to live sessions', () => {
  it('gives a session whose role carries tool namespaces those namespaces while it runs, once, when its provider declares live tools', async () => {
    const f = fixture({ capability: 'live', tools: 'tasks', role: { toolNamespaces: [namespace(WORKER_NAMESPACE), namespace('extra')] } });
    await f.wiring.applyWorkerTools();
    expect(f.updates.map(update => update.map(entry => entry.name))).toEqual([[WORKER_NAMESPACE, 'extra']]);
    await f.wiring.applyWorkerTools();
    expect(f.updates).toHaveLength(1);
    f.state.role = { toolNamespaces: [] };
    await f.wiring.applyWorkerTools();
    expect(f.updates.at(-1)).toEqual([]);
  });

  it('keeps today\'s path for a session without a role, and leaves providers that fix tools at creation or attachment alone', async () => {
    const plain = fixture({ capability: 'live', tools: 'tasks' });
    await plain.wiring.applyWorkerTools();
    expect(plain.updates.map(update => update.map(entry => entry.name))).toEqual([[WORKER_NAMESPACE]]);
    for (const capability of ['creation', 'attachment'] as const) {
      const fixed = fixture({ capability, tools: 'tasks', role: { toolNamespaces: [namespace(WORKER_NAMESPACE)] } });
      await fixed.wiring.applyWorkerTools();
      expect(fixed.updates).toEqual([]);
    }
  });
});
