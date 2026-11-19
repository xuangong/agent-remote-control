// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { FloatingPanel } from './FloatingPanel.js';

it('renders its landmark, named by its label', async () => {
  const container = await render(<><FloatingPanel as="aside" label="Details">Card</FloatingPanel><FloatingPanel label="Conversation">Bubbles</FloatingPanel></>);
  const [aside, section] = [...container.querySelectorAll('.orchard-panel')];
  expect([aside!.tagName, aside!.getAttribute('aria-label')]).toEqual(['ASIDE', 'Details']);
  expect([section!.tagName, section!.getAttribute('aria-label')]).toEqual(['SECTION', 'Conversation']);
});
