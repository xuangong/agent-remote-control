import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Icon, ICON_NAMES } from './Icon.js';

it('draws every icon as a decorative line drawing', async () => {
  const container = await render(<>{ICON_NAMES.map(name => <Icon key={name} name={name} />)}</>);
  const svgs = [...container.querySelectorAll('svg')];
  expect(svgs).toHaveLength(ICON_NAMES.length);
  for (const svg of svgs) {
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.querySelector('path')?.getAttribute('d')).toBeTruthy();
  }
});

it('sizes an icon in pixels', async () => {
  const container = await render(<Icon name="plus" size={20} />);
  expect(container.querySelector('svg')?.getAttribute('width')).toBe('20');
});
