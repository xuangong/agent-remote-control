// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { TimelineStepLevel } from './TimelineDisplay.js';
import { ReasoningItem } from './items/ReasoningItem.js';

it('shows the one-line level for untouched steps and retains a manual expansion through level and content updates', async () => {
  const renderItem = (level: 'summary' | 'preview', text: string) => <TimelineStepLevel.Provider value={level}><ReasoningItem item={{ type: 'reasoning', text }} /></TimelineStepLevel.Provider>;
  const container = await render(renderItem('summary', 'First thought'));
  expect(container.querySelector('.agent-content-preview')).toBeNull();
  await rerender(container, renderItem('preview', 'First thought'));
  expect(container.querySelector('.agent-content-preview')?.textContent).toBe('First thought');
  await act(async () => container.querySelector('button')!.click());
  await rerender(container, renderItem('summary', 'Updated thought'));
  expect(container.querySelector('.agent-reasoning-content')?.textContent).toBe('Updated thought');
  expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
});
