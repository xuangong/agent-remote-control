import { act } from 'react';
import { expect, it } from 'vitest';
import { App } from './App.js';
import { render } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

it('edits and restores a draft without reading unchanged conversation text', async () => {
  let reads = 0;
  const state = { ...replicaState, timeline: { ...replicaState.timeline, entries: Array.from({ length: 100 }, (_, index) => ({
    providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-09-22T00:00:00Z',
    sourceSeqRanges: [], collapsed: [], resources: [],
    item: { type: 'assistant_message' as const, get text() { reads++; return `History ${index}`; } },
  })) } };
  const container = await render(<App initialState={state} initialSessionStatus="ready" actions={{}} />);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  reads = 0;
  for (const text of ['A', 'A new', 'A new draft']) await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('A new draft');
  expect(reads).toBe(0);
  const restored = await render(<App initialState={state} initialSessionStatus="ready" actions={{}} />);
  expect(restored.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.value).toBe('A new draft');
});
