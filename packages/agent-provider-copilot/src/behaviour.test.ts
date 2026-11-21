import { resolveAgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';
import { expect, it } from 'vitest';

import { CopilotAgentProvider } from './provider.js';

it("declares the Copilot CLI's single writer, which the SDK reports at resume, and the limit it signals as an error", () => {
  const provider = new CopilotAgentProvider({ executable: '/not-started-for-a-declaration' });
  const declared = provider.descriptor.behaviour;
  expect(resolveAgentProviderBehaviour(provider.descriptor)).toBe(declared);
  expect(declared).toMatchObject({
    concurrency: { model: 'single_writer', probe: 'native', othersVisible: 'never' },
    resume: { cost: 'shared_process', deadlineMs: 15_000 },
    limits: { signal: 'error' },
    failures: { inUse: ['writer_elsewhere'] },
    liveOnly: ['interaction', 'reasoning', 'todo', 'error'],
  });
  expect(declared.verifiedVersion).toBeUndefined();
});
