import { act } from 'react';
import { expect, it } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { TimelineDisplay } from './TimelineDisplay.js';
import { ReasoningItem } from './items/ReasoningItem.js';

it('uses simple mode for untouched items and retains a manual expansion through mode and content updates', async () => {
  const renderItem = (mode: 'simple' | 'preview', text: string) => <TimelineDisplay.Provider value={mode}><ReasoningItem item={{ type: 'reasoning', text }} /></TimelineDisplay.Provider>;
  const container = await render(renderItem('simple', 'First thought'));
  expect(container.querySelector('.agent-content-preview')).toBeNull();
  await rerender(container, renderItem('preview', 'First thought'));
  expect(container.querySelector('.agent-content-preview')?.textContent).toBe('First thought');
  await act(async () => container.querySelector('button')!.click());
  await rerender(container, renderItem('simple', 'Updated thought'));
  expect(container.querySelector('.agent-reasoning-content')?.textContent).toBe('Updated thought');
  expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
});
