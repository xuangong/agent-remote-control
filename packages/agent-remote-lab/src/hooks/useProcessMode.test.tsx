// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { PROCESS_MODE_KEY, SHOW_LETTERS_KEY, useLettersVisible, useProcessMode, type ProcessAssistant, type ProcessModeChoice } from './useProcessMode.js';
import { removeLegacyDisplayModes } from '../device-store-start.js';

afterEach(() => { localStorage.clear(); });

function probe(assistant?: ProcessAssistant) {
  const seen: { current?: ProcessModeChoice } = {};
  function Probe() { seen.current = useProcessMode(assistant); return null; }
  return { seen, element: <Probe /> };
}
const bot = (details?: WindowBotDetails) => ({ details, update: vi.fn() });

it("takes the assistant's own mode, then this device's default, then Concise", async () => {
  const { seen, element } = probe(bot({ label: 'Chief', process: 'full' }));
  await render(element);
  expect(seen.current).toMatchObject({ mode: 'full', device: 'concise' });
  const follower = probe(bot({ label: 'Builder' }));
  await render(follower.element);
  expect(follower.seen.current?.mode).toBe('concise');
  await act(async () => follower.seen.current!.chooseForDevice('process'));
  expect(localStorage.getItem(PROCESS_MODE_KEY)).toBe('process');
  expect(follower.seen.current).toMatchObject({ mode: 'process', device: 'process' });
  expect(seen.current?.mode).toBe('full');
});

it("stores an assistant's choice in its bot details, keeping the others, and nothing when it is the device's default", async () => {
  localStorage.setItem(PROCESS_MODE_KEY, 'process');
  const assistant = bot({ label: 'Chief', picture: { shape: 'circle', color: '#3d8bff' } });
  const { seen, element } = probe(assistant);
  await render(element);
  seen.current!.chooseForAssistant!('full');
  expect(assistant.update).toHaveBeenLastCalledWith({ label: 'Chief', picture: { shape: 'circle', color: '#3d8bff' }, process: 'full' });
  seen.current!.chooseForAssistant!('concise');
  expect(assistant.update).toHaveBeenLastCalledWith({ label: 'Chief', picture: { shape: 'circle', color: '#3d8bff' }, process: 'concise' });
  const chosen = bot({ label: 'Chief', process: 'full' });
  const again = probe(chosen);
  await render(again.element);
  again.seen.current!.chooseForAssistant!('process');
  expect(chosen.update).toHaveBeenLastCalledWith({ label: 'Chief' });
});

it('offers only the device default for a view that is no assistant, and reads an unknown stored value as none', async () => {
  localStorage.setItem(PROCESS_MODE_KEY, 'preview');
  const { seen, element } = probe();
  await render(element);
  expect(seen.current?.chooseForAssistant).toBeUndefined();
  expect(seen.current).toMatchObject({ mode: 'concise', device: 'concise' });
});

it('keeps whether letters show on this device', async () => {
  const seen: { current?: ReturnType<typeof useLettersVisible> } = {};
  function Probe() { seen.current = useLettersVisible(); return null; }
  await render(<Probe />);
  expect(seen.current![0]).toBe(true);
  await act(async () => seen.current![1](false));
  expect(localStorage.getItem(SHOW_LETTERS_KEY)).toBe('false');
  expect(seen.current![0]).toBe(false);
});

it('removes the display modes of earlier releases once, and keeps every other key', () => {
  localStorage.setItem('agent-remote:recovery:https://relay/u/a/:view:main', '{"mode":"content","lettersVisible":true}');
  localStorage.setItem('agent-remote:timeline-display', 'simple');
  localStorage.setItem('agent-remote:recovery:https://relay/u/a/:drafts', '{}');
  localStorage.setItem(PROCESS_MODE_KEY, 'full');
  localStorage.setItem(SHOW_LETTERS_KEY, 'false');
  removeLegacyDisplayModes(localStorage);
  expect(Object.keys(localStorage).sort()).toEqual([PROCESS_MODE_KEY, SHOW_LETTERS_KEY, 'agent-remote:recovery:https://relay/u/a/:drafts'].sort());
});
