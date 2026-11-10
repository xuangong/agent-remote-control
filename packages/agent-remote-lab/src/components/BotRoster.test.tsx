import { act } from 'react';
import { expect, it } from 'vitest';
import { BotRoster } from './BotRoster.js';
import { projectBotRoster } from '../bot-roster.js';
import { botGroup, botTarget, visibleButton } from '../test/bot-mode-fixtures.js';
import { render } from '../test/setup.js';
import type { BotPlace } from '../workbench-mode.js';

it('renders accessible metadata and fallback Host identity without hidden members or invented results', async () => {
  const group = botGroup('A'); group.bots!.members = { A1: { label: 'Reviewer', picture: { shape: 'hexagon', color: '#123456' } }, A2: { hidden: true } };
  const model = projectBotRoster([group], [{ ...botTarget('Other'), hostId: 'host-a' }, { ...botTarget('Other'), hostId: 'host-b' }], () => 'offline');
  let selected: BotPlace | undefined;
  const container = await render(<BotRoster model={model} place={{ kind: 'bot', groupId: 'A', viewId: 'A1' }} onSelect={place => { selected = place; }} directoryControls={<button>Refresh</button>} />);
  expect(container.querySelector('nav[aria-label="Bots"]')).not.toBeNull();
  expect(container.textContent).toContain('Reviewer'); expect(container.textContent).not.toContain('A2');
  expect(container.textContent).not.toMatch(/Failed|New result/);
  expect(container.textContent).toContain('host-a'); expect(container.textContent).toContain('host-b');
  expect(visibleButton(container, 'A1').getAttribute('aria-current')).toBe('true');
  expect(container.querySelector('[data-shape="hexagon"]')?.getAttribute('style')).toContain('#123456');
  await act(async () => visibleButton(container, 'A1').click());
  expect(selected).toEqual({ kind: 'bot', groupId: 'A', viewId: 'A1' });
  expect([...container.querySelectorAll('h2,h3')].at(-1)?.textContent).toBe('Other sessions');
});
