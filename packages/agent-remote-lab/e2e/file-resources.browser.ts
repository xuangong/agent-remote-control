import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { onPreviewCleanup, previewFixture } from '../src/server/preview-tunnel-fixture.js';

for (const engine of [chromium, webkit]) for (const width of [390, 1280]) {
  it(`reads local files and images in a read-only sidebar in ${engine.name()} at ${width}px`, async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'arc-file-preview-')));
    onPreviewCleanup(() => rm(workspace, { recursive: true, force: true }));
    const codePath = join(workspace, 'main.ts');
    await writeFile(codePath, 'export const greeting = "你好";\n// Read only');
    await mkdir(join(workspace, 'docs'));
    await mkdir(join(workspace, 'appendix'));
    await writeFile(join(workspace, 'docs/report.md'), [
      '# Report', '**Summary**', '- First finding\n- Second finding',
      '| One | Two | Three | Four | Five | Six |\n| --- | --- | --- | --- | --- | --- |\n| Ready | Ready | Ready | Ready | Ready | Ready |',
      '```text\n' + 'Long code sample '.repeat(30) + '\n```',
      '![Report diagram](./report.png)', '[Notes](../appendix/notes.md)',
      'This is a long paragraph for reading on a mobile screen. '.repeat(20),
      '<script>window.fileExecuted = true</script>',
    ].join('\n\n'));
    await writeFile(join(workspace, 'appendix/notes.md'), '# Notes\n\n![Nested diagram](./nested.png)\n\n[Report](../docs/report.md)');
    await writeFile(join(workspace, 'page.html'), '<!doctype html><script>window.fileExecuted = true</script>');
    const png = await readFile(new URL('./fixtures/markdown-wide.png', import.meta.url));
    await writeFile(join(workspace, 'wide.png'), png);
    await writeFile(join(workspace, 'docs/report.png'), png);
    await writeFile(join(workspace, 'appendix/nested.png'), png);
    const css = await readFile(new URL('../../agent-remote-web/src/styles.css', import.meta.url), 'utf8');
    let browserScript = '';
    const fixture = await previewFixture({ workspace, servePage: async (request, response) => {
      if (request.url === '/file-test.js') { response.setHeader('content-type', 'application/javascript; charset=utf-8'); response.end(browserScript); return true; }
      if (request.url === '/file-test') {
        response.setHeader('content-type', 'text/html');
        response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} body { margin:0; } .test-stage { height:100dvh; } .test-chat { padding:16px; }</style><div id="root"></div><script src="/file-test.js"></script>`);
        return true;
      }
      return false;
    } });
    const markdown = `[Code](${codePath}#L2) [Markdown](./docs/report.md) [Markdown line](./docs/report.md#L3) [HTML](file://${workspace}/page.html) [Missing](./missing.ts) [Denied](/etc/hosts)\n\n![Diagram](./wide.png)`;
    const source = `
      import React, { useSyncExternalStore, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@orchardworks/agent-remote-web/headless';
      import { MarkdownContent } from '../../agent-remote-web/src/react/MarkdownContent.tsx';
      import { PreviewWorkspace } from '../../agent-remote-web/src/react/PreviewWorkspace.tsx';
      const replica = new AgentReplica();
      const client = new RemoteSessionClient(${JSON.stringify(fixture.agentId)}, new HttpWebSocketTransport(${JSON.stringify(fixture.url + fixture.alice.basePath)}), replica);
      const resolveResource = (locator, source) => client.resolveResource(locator, source);
      const requestResource = async binding => (await client.requestResource(binding.resourceId)).payload.state;
      function View() {
        const state = useSyncExternalStore(callback => replica.subscribe(callback), () => replica.getState());
        const [scope, setScope] = useState('session');
        window.switchScope = () => setScope('other');
        const context = { scopeKey: state.agent.id, bindings: [], resources: state.resources, resolveResource, requestResource };
        return <PreviewWorkspace className="test-stage" resourceScope={scope}><div className="test-chat"><textarea aria-label="Conversation input" /><MarkdownContent markdown={${JSON.stringify(markdown)}} resourceContext={context} /></div></PreviewWorkspace>;
      }
      const root = createRoot(document.getElementById('root'));
      client.subscribeStatus(status => { if (status === 'ready') root.render(<View />); });
      client.start();
    `;
    const bundled = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
      bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
    browserScript = bundled.outputFiles[0]!.text;
    const browser = await engine.launch({ headless: true });
    onPreviewCleanup(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width <= 760, isMobile: width <= 760 });
    page.setDefaultTimeout(10_000);
    const separator = fixture.alice.cookie.indexOf('=');
    await page.context().addCookies([{ name: fixture.alice.cookie.slice(0, separator), value: fixture.alice.cookie.slice(separator + 1), url: fixture.url, httpOnly: true, sameSite: 'Strict' }]);
    const errors: string[] = [];
    const fileRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/etc/hosts') || request.url().includes(workspace)) fileRequests.push(request.url()); });
    await page.goto(fixture.url + '/file-test');
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
    const panel = page.getByRole('dialog', { name: 'File preview' });
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await expect.poll(() => panel.locator('.cm-content').textContent()).toContain('export const greeting');
    expect(await panel.locator('.cm-content').getAttribute('contenteditable')).toBe('false');
    await panel.locator('.cm-content').focus();
    await page.keyboard.type('unexpected edit');
    expect(await panel.locator('.cm-content').textContent()).not.toContain('unexpected edit');
    const box = await panel.boundingBox();
    expect(box!.width).toBeCloseTo(width <= 760 ? width : width / 2, 0);
    if (width > 760) {
      await page.getByRole('textbox', { name: 'Conversation input' }).fill('Conversation remains interactive');
      const divider = page.getByRole('separator');
      await divider.focus(); await page.keyboard.press('ArrowLeft');
      expect((await panel.boundingBox())!.width).toBeGreaterThan(box!.width);
    }
    await page.screenshot({ path: join(tmpdir(), `arc-file-preview-${engine.name()}-${width}.png`) });
    await writeFile(codePath, 'export const refreshed = true;');
    await panel.getByRole('button', { name: 'Refresh file' }).click();
    await expect.poll(() => panel.locator('.cm-content').textContent()).toContain('refreshed');
    await panel.getByRole('button', { name: 'Close file preview' }).click();
    await page.getByRole('button', { name: 'Markdown', exact: true }).click();
    await expect.poll(() => panel.locator('h1').textContent()).toBe('Report');
    expect(await panel.locator('.agent-file-markdown strong').textContent()).toBe('Summary');
    expect(await panel.locator('.agent-file-markdown table').count()).toBe(1);
    expect(await panel.locator('.agent-file-markdown li').count()).toBe(2);
    expect(await panel.locator('.cm-content').count()).toBe(0);
    expect(await panel.getByRole('button', { name: 'Wrap lines' }).count()).toBe(0);
    await expect.poll(() => panel.getByRole('img', { name: 'Report diagram', exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
    await expect.poll(() => panel.getByRole('img', { name: 'Report diagram', exact: true }).evaluate(image => getComputedStyle(image).opacity)).toBe('1');
    expect(await panel.locator('.agent-file-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => (window as any).fileExecuted)).toBeUndefined();
    await page.screenshot({ path: join(tmpdir(), `arc-markdown-preview-${engine.name()}-${width}.png`) });
    await panel.getByRole('button', { name: 'Show Markdown source' }).click();
    await expect.poll(() => panel.locator('.cm-content').textContent()).toContain('**Summary**');
    const measureSource = () => panel.locator('.cm-content').evaluate(element => {
      const text = element.querySelector('.cm-line')!;
      const range = document.createRange(); range.selectNodeContents(text);
      return { font: getComputedStyle(text).fontSize, height: range.getBoundingClientRect().height,
        scale: window.visualViewport?.scale };
    });
    const wrapped = await measureSource();
    await panel.getByRole('button', { name: 'Wrap lines', exact: true }).click();
    await expect.poll(() => panel.locator('.cm-lineWrapping').count()).toBe(0);
    const unwrapped = await measureSource();
    expect(unwrapped.height).toBeCloseTo(wrapped.height, 1);
    expect(unwrapped.font).toBe(wrapped.font);
    expect(unwrapped.scale).toBe(wrapped.scale);
    await panel.getByRole('button', { name: 'Wrap lines', exact: true }).click();
    await expect.poll(() => panel.locator('.cm-lineWrapping').count()).toBe(1);
    expect((await measureSource()).height).toBeCloseTo(wrapped.height, 1);
    await panel.getByRole('button', { name: 'Show rendered Markdown' }).click();
    await panel.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect.poll(() => panel.locator('h1').textContent()).toBe('Notes');
    await expect.poll(() => panel.getByRole('img', { name: 'Nested diagram', exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
    await expect.poll(() => panel.getByRole('img', { name: 'Nested diagram', exact: true }).evaluate(image => getComputedStyle(image).opacity)).toBe('1');
    await panel.getByRole('button', { name: 'Report', exact: true }).click();
    await expect.poll(() => panel.locator('h1').textContent()).toBe('Report');
    await panel.getByRole('button', { name: 'Close file preview' }).click();
    expect(await page.getByRole('button', { name: 'Markdown', exact: true }).evaluate(button => button === document.activeElement)).toBe(true);
    await page.getByRole('button', { name: 'Markdown line', exact: true }).click();
    await expect.poll(() => panel.locator('.cm-content').textContent()).toContain('**Summary**');
    expect(await panel.locator('.cm-activeLineGutter').textContent()).toBe('3');
    await panel.getByRole('button', { name: 'Show rendered Markdown' }).click();
    await expect.poll(() => panel.locator('h1').textContent()).toBe('Report');
    await panel.getByRole('button', { name: 'Close file preview' }).click();
    await page.getByRole('button', { name: 'HTML', exact: true }).click();
    await expect.poll(() => panel.locator('.cm-content').textContent()).toContain('<script>');
    expect(await page.evaluate(() => (window as any).fileExecuted)).toBeUndefined();
    await panel.getByRole('button', { name: 'Close file preview' }).click();
    await page.getByRole('button', { name: 'Missing', exact: true }).click();
    await expect.poll(() => panel.getByRole('alert').textContent()).toContain('does not exist');
    await writeFile(join(workspace, 'missing.ts'), 'Recovered file');
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => panel.locator('.cm-content').textContent()).toContain('Recovered file');
    await panel.getByRole('button', { name: 'Close file preview' }).click();
    await page.getByRole('button', { name: 'Denied', exact: true }).click();
    await expect.poll(() => panel.getByRole('alert').textContent()).toContain('outside the authorized roots');
    expect(await panel.locator('.cm-content').count()).toBe(0);
    await panel.getByRole('button', { name: 'Close file preview' }).click();
    await page.getByRole('button', { name: 'Open image: Diagram' }).click();
    const imagePanel = page.getByRole('dialog', { name: 'Image preview', exact: true });
    await expect.poll(() => imagePanel.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
    expect((await imagePanel.boundingBox())!.width).toBeGreaterThanOrEqual(width * 0.98);
    await page.evaluate(() => (window as any).switchScope());
    await expect.poll(() => imagePanel.count()).toBe(0);
    expect(fileRequests).toEqual([]);
    expect(errors).toEqual([]);
  }, 45_000);
}
