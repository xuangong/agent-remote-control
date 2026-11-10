import { createRef } from 'react';
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Toolbar } from './Toolbar.js';

it('shows the current object as a heading on the left and its actions on the right', async () => {
  const container = await render(<Toolbar leading={<span data-testid="avatar" />} title="API caching" subtitle="Backend review · Idle"
    trailing={<button type="button">Threads</button>} />);
  const bar = container.querySelector('header.ui-toolbar')!;
  expect([...bar.children].map(child => child.className)).toEqual(['ui-toolbar-leading', 'ui-toolbar-heading', 'ui-toolbar-trailing']);
  expect(bar.querySelector('[data-testid="avatar"]')).not.toBeNull();
  expect(bar.querySelector('h2.ui-toolbar-title')?.textContent).toBe('API caching');
  expect(bar.querySelector('.ui-toolbar-subtitle')?.textContent).toBe('Backend review · Idle');
  expect(bar.querySelector('.ui-toolbar-trailing button')?.textContent).toBe('Threads');
});

it('leaves out what a toolbar does not have', async () => {
  const container = await render(<Toolbar title="Product" />);
  expect(container.querySelector('.ui-toolbar-subtitle')).toBeNull();
  expect(container.querySelector('.ui-toolbar-leading')).toBeNull();
  expect(container.querySelector('.ui-toolbar-trailing')).toBeNull();
  expect(container.querySelector('h2')?.hasAttribute('tabindex')).toBe(false);
});

it('can carry a class and a focusable heading for its owner', async () => {
  const heading = createRef<HTMLHeadingElement>();
  const container = await render(<Toolbar className="lab-bot-conversation-toolbar" title="API caching" titleRef={heading} titleFocusable />);
  expect(container.querySelector('header')?.className).toBe('ui-toolbar lab-bot-conversation-toolbar');
  expect(heading.current?.textContent).toBe('API caching');
  expect(heading.current?.getAttribute('tabindex')).toBe('-1');
});
