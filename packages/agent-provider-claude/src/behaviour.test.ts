import { resolveAgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';
import { expect, it } from 'vitest';

import { ClaudeAgentProvider } from './provider.js';

it('declares that Claude Code forks a transcript two writers use, and that only a reread shows the other writer', () => {
  const provider = new ClaudeAgentProvider({ catalog: { async list() { return []; }, async info() { return undefined; }, async messages() { return []; } } });
  const declared = provider.descriptor.behaviour;
  expect(resolveAgentProviderBehaviour(provider.descriptor)).toBe(declared);
  expect(declared).toMatchObject({
    concurrency: { model: 'fork_on_divergence', probe: 'none', othersVisible: 'on_reread' },
    reread: { order: 'siblings_unordered', withoutAttach: true, cost: 'whole_session' },
    resume: { cost: 'process', deadlineMs: 15_000 },
    input: { identity: 'echoes_client_id' },
    limits: { signal: 'event' },
    liveOnly: ['interaction', 'synthetic_output'],
    verifiedVersion: '2.1.319',
  });
});
