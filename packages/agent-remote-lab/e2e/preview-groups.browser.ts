import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';
import { expect, it } from 'vitest';

it.each(['chromium', 'webkit'] as const)('keeps Host groups and pinned mapping actions compact in %s', async name => {
  const engine = name === 'chromium' ? chromium : webkit;
  const css = await readFile(new URL('../src/app.css', import.meta.url), 'utf8');
  const source = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {HostPreviewGroups} from './components/HostPreviewGroups.tsx';
    const pinned = new Set(); let inactive = false;
    const client = {
      async snapshot(host) {return {routing:'subdomain', pinnedNames: inactive && pinned.has(host) ? [{nameId:'preview-'+host,target:'http://localhost:5173',tunnelOrigin:'https://rose-seal-233f1df48bea.agents.example.test'}] : [], registrations:inactive ? [] : [{
        id:'preview-'+host,target:'http://localhost:5173/a/long/application/path',
        tunnelOrigin:'https://rose-seal-233f1df48bea.agents.example.test',
        tunnelNamePinned:pinned.has(host),status:'active',availability:'online',pathMode:'strip',
        expiresAt:Date.now()+3600000,sources:[{sessionId:'source',itemId:'message'}]
      }]};},
      async pinName(host,id,value){if(value)pinned.add(host);else pinned.delete(host);},
      async unpinName(host,id){pinned.delete(host);}
    };
    createRoot(document.getElementById('root')).render(<><section className='lab-host-pairing'>You own this Host</section><section className='lab-host-vscode'><h2>VS Code</h2></section><HostPreviewGroups client={client}
      hosts={[{id:'work',name:'Work Mac',online:true},{id:'home',name:'Home Mac',online:true}]}
      polling onOpen={()=>{}} onOpenSource={(session,item,host)=>document.body.dataset.sourceHost=host}/><button id='release' onClick={()=>{inactive=true;document.dispatchEvent(new Event('visibilitychange'));}}>Release previews</button></>);
  `;
  const script = (await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
    bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0]!.text;
  const server = createServer((request, response) => {
    response.setHeader('content-type', request.url === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    response.end(request.url === '/app.js' ? script : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
      body{margin:0;padding:12px}#root{width:340px;max-width:100%}</style><div id="root"></div><script src="/app.js"></script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser: Awaited<ReturnType<typeof engine.launch>> | undefined;
  try {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await mkdir(fileURLToPath(new URL('../test-results/pinned-previews/', import.meta.url)), { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`);
      try { await page.getByRole('heading', { name: 'Home Mac', exact: true }).waitFor(); }
      catch (error) { console.error({ errors, body: await page.locator('body').innerText() }); throw error; }
      const groups = page.locator('.lab-host-previews');
      expect(await groups.count()).toBe(2);
      for (const group of await groups.all()) {
        expect(await group.locator('.lab-preview-mapping').innerText()).toContain('rose-seal-233f1df48bea.agents.example.test');
        const metrics = await group.locator('.lab-preview-actions').evaluate(element => {
          const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
          return { top: buttons.map(button => button.top), width: element.clientWidth, scroll: element.scrollWidth };
        });
        expect(new Set(metrics.top).size).toBe(1);
        expect(metrics.scroll).toBeGreaterThan(metrics.width);
      }
      await groups.nth(1).getByRole('button', { name: 'Pin tunnel name', exact: true }).click();
      await groups.nth(1).getByRole('button', { name: 'Unpin tunnel name', exact: true }).waitFor();
      expect(await groups.nth(0).getByRole('button', { name: 'Pin tunnel name', exact: true }).count()).toBe(1);
      await groups.nth(1).getByRole('button', { name: 'Open source 1', exact: true }).click();
      expect(await page.locator('body').getAttribute('data-source-host')).toBe('home');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('#release').click();
      await page.getByText('Name reserved', {exact:true}).waitFor();
      expect(await groups.count()).toBe(1);
      expect(await groups.first().innerText()).toContain('Home Mac');
      expect(await groups.locator('.lab-preview-open').count()).toBe(0);
      await page.screenshot({ path: fileURLToPath(new URL(`../test-results/pinned-previews/reserved-${engine.name()}-${width}.png`, import.meta.url)), fullPage: true });
      await groups.getByRole('button', {name:'Unpin tunnel name',exact:true}).click();
      await page.locator('.lab-preview-groups').waitFor({state:'hidden'});
      expect(await page.locator('.lab-host-previews').count()).toBe(0);
      const borders = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.lab-host-pairing')!).borderBottomWidth)
        + parseFloat(getComputedStyle(document.querySelector('.lab-host-vscode')!).borderTopWidth));
      expect(borders).toBe(1);

      await page.screenshot({ path: fileURLToPath(new URL(`../test-results/pinned-previews/${engine.name()}-${width}.png`, import.meta.url)), fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally {
    await browser?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30000);
