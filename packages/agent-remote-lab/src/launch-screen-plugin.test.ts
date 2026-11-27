// @vitest-environment node
import { expect, it } from 'vitest';
import { stylesheetsAfterLaunchScreen } from '../launch-screen-plugin.js';

const built = (head: string, body = '<div id="root"></div><div id="launch"></div>') => `<html><head>${head}</head><body>${body}</body></html>`;

it('moves the built stylesheets after the launch screen, so the first paint waits for none of them', () => {
  const page = built('<script type="module" src="/assets/index-1.js"></script><link rel="stylesheet" crossorigin href="/assets/index-1.css"><link rel="icon" href="/favicon.svg">');
  const moved = stylesheetsAfterLaunchScreen(page);
  const [head = '', body = ''] = moved.split('<body>');
  expect(head).not.toContain('stylesheet');
  expect(head).toContain('<link rel="icon" href="/favicon.svg">');
  expect(body.indexOf('id="launch"')).toBeLessThan(body.indexOf('stylesheet'));
  expect(body).toContain('href="/assets/index-1.css"');
});

it('leaves a page without stylesheets as it is', () => {
  const page = built('<title>Orchard</title>');
  expect(stylesheetsAfterLaunchScreen(page)).toBe(page);
});
