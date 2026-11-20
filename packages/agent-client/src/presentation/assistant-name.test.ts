import { describe, expect, it } from 'vitest';
import { agentName, assistantName, assistantNames } from './assistant-name.js';
import { ASSISTANT_NAME_VECTORS } from './assistant-name.vectors.js';

describe('assistantNames', () => {
  it.each(ASSISTANT_NAME_VECTORS)('$name', ({ assistants, names }) => {
    const named = assistantNames(assistants);
    expect(assistants.map(assistant => named.get(assistant.key))).toEqual(names);
  });
});

describe('assistantName', () => {
  it('names one assistant among those shown with it, and alone by default', () => {
    const together = [{ key: 'a', providerId: 'claude' }, { key: 'b', providerId: 'claude' }];
    expect(assistantName(together[1]!, together)).toBe('Claude 2');
    expect(assistantName(together[1]!)).toBe('Claude');
    expect(assistantName({ key: 'c', providerId: 'claude' }, together)).toBe('Claude 3');
  });

  it('is a name, never a prompt: no plain session is called by more than its agent and a number', () => {
    for (const { assistants } of ASSISTANT_NAME_VECTORS) {
      const named = assistantNames(assistants);
      for (const assistant of assistants.filter(item => !item.bot?.trim())) {
        expect(named.get(assistant.key)).toMatch(new RegExp(`^${agentName(assistant.providerId, assistant.providerName)}( \\d+)?$`));
      }
    }
  });
});
