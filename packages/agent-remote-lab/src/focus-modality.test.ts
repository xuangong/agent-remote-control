import { expect, it } from 'vitest';
import { trackFocusModality } from './focus-modality.js';

it('tracks dynamically mounted iframe input and releases detached documents', async () => {
  const stop = trackFocusModality(document);
  const frame = document.createElement('iframe');
  try {
    document.body.append(frame);
    await Promise.resolve();
    const child = frame.contentDocument!;
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.documentElement.dataset.inputModality).toBe('keyboard');
    child.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.documentElement.dataset.inputModality).toBe('pointer');

    frame.remove();
    await Promise.resolve();
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.documentElement.dataset.inputModality).toBe('pointer');
  } finally { frame.remove(); stop(); }
});

it('cleans up input tracking and ignores modifier shortcuts', () => {
  const stop = trackFocusModality(document);
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true }));
    expect(document.documentElement.dataset.inputModality).toBe('pointer');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(document.documentElement.dataset.inputModality).toBe('keyboard');
  } finally { stop(); }
  document.dispatchEvent(new Event('pointerdown'));
  expect(document.documentElement.dataset.inputModality).toBeUndefined();
});
