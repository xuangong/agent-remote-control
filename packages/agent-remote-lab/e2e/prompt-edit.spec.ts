import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createPortProbe } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { expect, test } from '@playwright/test';
import { createProtocolValidationServer } from '../src/server.js';
import { SessionDirectoryClient } from '../src/directory-client.js';
import { createBrowserPrefixAdapter } from '../../agent-remote-debugger/e2e/fixtures/browser-prefix-adapter.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lab-prefix-browser-'));
  const probe = createPortProbe();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, adapter = createBrowserPrefixAdapter(root);
  const server = createProtocolValidationServer({ providers: [adapter], labOrigin: origin, successionStateDirectory: join(root, 'state'),
    imageDirectory: join(root, 'images'), resourceDirectory: join(root, 'resources'), teamResourceDirectory: join(root, 'team-resources') });
  const vite = await createViteServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false }, appType: 'mpa' });
  const listeners = server.http.server.listeners('request');
  server.http.server.removeAllListeners('request');
  server.http.server.on('request', (request, response) => {
    if (request.url?.startsWith('/v1/')) { for (const listener of listeners) listener.call(server.http.server, request, response); }
    else vite.middlewares(request, response, () => { response.writeHead(404).end(); });
  });
  await server.http.listen(port);
  const directory = new SessionDirectoryClient(origin, (input, init) => fetch(input, { ...init, headers: { ...init?.headers, origin }, signal: init?.signal ?? AbortSignal.timeout(5000) }));
  const main = await directory.create('prefix-fixture', 'main', { cwd: root });
  const source = await directory.create('prefix-fixture', 'source', { cwd: root });
  return { origin, adapter, main: { ...main, hostId: 'local', providerId: 'prefix-fixture', title: 'Unrelated Main' }, source: { ...source, hostId: 'local', providerId: 'prefix-fixture', title: 'Team participant' },
    async close() { await vite.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}
for (const placement of ['team-leader', 'team-member', 'side', 'ask', 'tpm']) {
  test(`${placement} edits its own prompt through HTTP and WebSocket`, async ({ page, isMobile }, info) => {
    const f = await fixture(), operations: Array<{ action: string; body: any }> = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { const action = /\/succession\/(prepare|commit)/.exec(request.url())?.[1]; if (action) operations.push({ action, body: request.postDataJSON() }); });
    try {
      await page.goto(`${f.origin}/e2e/fixtures/prompt-edit.html?${new URLSearchParams({ placement, source: JSON.stringify(f.source), main: JSON.stringify(f.main) })}`);
      const row = page.locator('[data-prompt-editable]').filter({ hasText: 'selected prompt' });
      await expect(row).toHaveCount(1);
      if (isMobile) {
        await row.scrollIntoViewIfNeeded();
        const bounds = (await row.boundingBox())!, touch = await page.context().newCDPSession(page);
        const point = { x: Math.min(bounds.x + bounds.width - 36, page.viewportSize()!.width - 36), y: bounds.y + Math.min(30, bounds.height / 2), id: 1 };
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        for (let step = 1; step <= 4; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x - step * 42 }] });
        await expect(row).toHaveAttribute('data-time-revealed', 'true');
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await touch.detach();
        await row.locator('[data-prompt-edit-action]:visible').tap();
      } else { await row.hover(); await row.locator('[data-prompt-edit-action]:visible').click(); }
      const editor = page.getByTestId('prompt-input');
      await expect(editor).toHaveText('selected prompt');
      await expect(page.locator('.lab-handoff-notice')).toHaveCount(0);
      await expect(page.getByTestId('unrelated-main')).toHaveText(f.main.nativeSessionId!);
      expect(operations.filter(item => item.action === 'prepare')).toHaveLength(1);
      expect(operations[0]!.body).toMatchObject({ nativeSessionId: f.source.nativeSessionId, preparation: { kind: 'native_prefix', turnId: 'turn-1', messageId: 'message-1' } });
      expect(operations.filter(item => item.action === 'commit')).toHaveLength(1);
      const state = await f.adapter.state();
      expect(state.forks).toBe(1); expect(state.sessions['candidate-1']!.inputs).toEqual([]); expect(state.sessions[f.main.nativeSessionId!]!.inputs).toEqual([]);
      expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${placement}.png`), fullPage: true });
    } finally { await f.close(); }
  });
}
