import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect as browserExpect, type Page } from '@playwright/test';
import { afterEach, expect, it } from 'vitest';

import { startRelayAndController, SESSION, type Relay } from '@orchardworks/agent-remote-controller/testing/relay-session-harness';

const started: Relay[] = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });

/**
 * A session page over real transports: the product's composer and session client in a real browser, connected over a real
 * WebSocket to a Relay that serves the page, with a real Controller behind it and a scripted provider.
 */
async function sessionPage(journalServed: boolean) {
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './session-view-styles.ts';
    import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@orchardworks/agent-client';
    import { useSessionView } from '@orchardworks/agent-client-web';
    import { LabWorkbench } from './conversation/LabWorkbench.tsx';
    const query = new URLSearchParams(location.search);
    const transport = new HttpWebSocketTransport(location.origin);
    const connections = { acquire(id, replica) {
      const client = new RemoteSessionClient(id, transport, replica, { historyPageSize: 100, requireSessionControl: true, reconnectInitialDelayMs: 50, controlExtension: {
        async resumeNative(owner) {
          const response = await fetch('/v1/remote/hosts/' + query.get('host') + '/attach', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerId: 'fake', nativeSessionId: '${SESSION}', takeOver: owner.generation }) });
          if (!response.ok) throw new Error('The take-over was refused.');
        } } });
      client.start();
      return { client, replica, release: () => client.stop() };
    } };
    function View() {
      const view = useSessionView({ agentId: query.get('agent'), transport, source: connections });
      return <LabWorkbench state={view.state} sessionState={view.sessionState} sessionStatus={view.status} actions={view.actions}
        />;
    }
    createRoot(document.getElementById('root')).render(<View />);
  `;
  const bundled = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
    bundle: true, write: false, outfile: 'fixture.js', loader: { '.woff2': 'dataurl' }, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = bundled.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  const css = bundled.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  const relay = await startRelayAndController({ journalServed, page: {
    '/fixture.js': { type: 'application/javascript', body: script },
    '/page': { type: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n#root { height: 100dvh; }</style><div id="root"></div><script src="/fixture.js"></script>` },
  } });
  started.push(relay);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 812 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${relay.origin}/page?agent=${relay.agentId}&host=${relay.hostId}`);
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await browserExpect(input).toBeVisible();
  await browserExpect(input).toBeEnabled();
  return { relay, page, input, errors, close: () => browser.close() };
}

const sentTexts = (relay: Relay) => relay.sessions.flatMap(session => session.sent);
const typeAndSend = async (page: Page, text: string) => {
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill(text);
  await input.press('Enter');
};

for (const journalServed of [true, false]) {
  it(`holds the text in the queue as Not sent when a ${journalServed ? 'journal-served' : 'crude'} session was taken by a terminal, offers take-over, and Retry sends the same text once after it`, async () => {
    const view = await sessionPage(journalServed);
    try {
      await typeAndSend(view.page, 'first');
      await browserExpect(view.input).toHaveValue('');
      await expect.poll(() => sentTexts(view.relay)).toEqual(['first']);
      await view.relay.terminalTakes();
      await view.input.fill('draft that must survive');
      await view.input.press('Enter');
      // The refusal delivered nothing: the text waits in the queue chip as Not sent, and the take-over is offered.
      const takeOver = view.page.getByRole('button', { name: 'Interrupt and take control' });
      await browserExpect(takeOver).toBeVisible();
      const chip = view.page.getByTestId('pending-send');
      await browserExpect(chip).toContainText('draft that must survive');
      await browserExpect(chip.locator('.agent-pending-state')).toHaveText('Not sent');
      expect(sentTexts(view.relay)).toEqual(['first']);
      await takeOver.click();
      await browserExpect(takeOver).toBeHidden();
      await browserExpect(view.input).toBeEditable();
      await view.page.getByRole('button', { name: 'Retry pending send' }).click();
      await expect.poll(() => sentTexts(view.relay)).toEqual(['first', 'draft that must survive']);
      await browserExpect(chip).toHaveCount(0);
      expect(view.errors).toEqual([]);
    } finally { await view.close(); }
  }, 60_000);
}

it('holds the text as Not sent and says why when the Host is offline, then Retry sends it once the Host is back', async () => {
  const view = await sessionPage(true);
  try {
    await view.relay.stopController();
    await view.input.fill('while the Host is away');
    await view.input.press('Enter');
    await browserExpect(view.page.getByText(/offline/i).first()).toBeVisible();
    const chip = view.page.getByTestId('pending-send');
    await browserExpect(chip).toContainText('while the Host is away');
    await browserExpect(chip.locator('.agent-pending-state')).toHaveText('Not sent');
    expect(sentTexts(view.relay)).toEqual([]);
    await view.relay.startController();
    // Retry sends it once the Host is back; the page reconnects on its own.
    await expect.poll(async () => {
      await view.page.getByRole('button', { name: 'Retry pending send' }).click({ timeout: 1000 }).catch(() => {});
      return sentTexts(view.relay);
    }, { timeout: 20_000 }).toEqual(['while the Host is away']);
    await browserExpect(chip).toHaveCount(0);
    expect(view.errors).toEqual([]);
  } finally { await view.close(); }
}, 60_000);
