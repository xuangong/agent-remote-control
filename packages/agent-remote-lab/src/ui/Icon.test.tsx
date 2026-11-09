import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Icon, ICON_NAMES } from './Icon.js';

it('draws every icon as a decorative line drawing', async () => {
  const container = await render(<>{ICON_NAMES.map(name => <Icon key={name} name={name} />)}</>);
  const svgs = [...container.querySelectorAll('svg')];
  expect(svgs).toHaveLength(ICON_NAMES.length);
  const paths: string[] = [];
  for (const svg of svgs) {
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('stroke-linejoin')).toBe('round');
    const d = svg.querySelector('path')?.getAttribute('d') ?? '';
    expect(d).toMatch(/^M[\d.\s,MLHVCSQTAZmlhvcsqtaz-]+$/);
    paths.push(d);
  }
  expect(new Set(paths).size).toBe(paths.length);
});

it('sizes an icon in pixels', async () => {
  const container = await render(<Icon name="plus" size={20} />);
  const svg = container.querySelector('svg');
  expect(svg?.getAttribute('width')).toBe('20');
  expect(svg?.getAttribute('height')).toBe('20');
});

it('defaults an icon to 18 pixels', async () => {
  const container = await render(<Icon name="plus" />);
  const svg = container.querySelector('svg');
  expect(svg?.getAttribute('width')).toBe('18');
  expect(svg?.getAttribute('height')).toBe('18');
});
