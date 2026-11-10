import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';

it('renders a non-submitting button with its variant and size', async () => {
  const onClick = vi.fn();
  const container = await render(<form><Button variant="primary" size="small" onClick={onClick}>Create</Button></form>);
  const button = container.querySelector('button')!;
  expect(button.type).toBe('button');
  expect(button.className).toBe('ui-button');
  expect(button.dataset.variant).toBe('primary');
  expect(button.dataset.size).toBe('small');
  await act(async () => button.click());
  expect(onClick).toHaveBeenCalledOnce();
});

it('defaults to a regular secondary button and keeps extra classes', async () => {
  const container = await render(<Button className="lab-extra">Cancel</Button>);
  const button = container.querySelector('button')!;
  expect(button.dataset.variant).toBe('secondary');
  expect(button.dataset.size).toBe('regular');
  expect(button.className).toBe('ui-button lab-extra');
});

it('names an icon button by its label', async () => {
  const container = await render(<IconButton icon="plus" label="New Bot" />);
  const button = container.querySelector('button')!;
  expect(button.getAttribute('aria-label')).toBe('New Bot');
  expect(button.title).toBe('New Bot');
  expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
});
