import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect as browserExpect } from '@playwright/test';
import { expect, it } from 'vitest';

it.each(['chromium', 'webkit'] as const)('reaches the last favorite within the popover in %s', async name => {
  const source = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {FavoritesMenu} from './components/SessionFavorites.tsx';
    const favorites = {enabled:true,scope:'scroll-test',folders:[],stars:Array.from({length:20},(_,i)=>({hostId:'host',providerId:'codex',nativeSessionId:String(i),favoriteId:'favorite-'+i,folderId:null,order:i,title:'Favorite '+i,hostName:'Work Mac',available:true,online:true})),refresh:async()=>{}};
    createRoot(document.getElementById('root')).render(<FavoritesMenu title="Current session" currentSession={{hostId:'host',providerId:'codex',nativeSessionId:'0',title:'Current session'}} favorites={favorites} tracking={{sessions:[],toggle(){}}} busy={false} onScan={()=>{}} onOpen={item=>document.body.dataset.open=item.nativeSessionId}/>);`;
  const script = (await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0]!.text;
  const css = await readFile(new URL('../src/app.css', import.meta.url), 'utf8');
  const server = createServer((req, res) => {
    res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/app.js' ? script : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{margin:0}#root{width:360px;max-width:100%;margin:0 auto}</style><div id="root"></div><script src="/app.js"></script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await (name === 'chromium' ? chromium : webkit).launch();
  const output = new URL('../test-results/favorites-scroll/', import.meta.url);
  await mkdir(output, { recursive: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
      const page = await browser.newPage({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      await page.getByRole('button', { name: 'Favorites', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Favorites', exact: true });
      const scroll = panel.locator('.lab-favorites-scroll');
      await browserExpect(scroll).toBeVisible();
      if (name === 'chromium' && viewport.width === 390) {
        const box = (await scroll.boundingBox())!;
        const cdp = await page.context().newCDPSession(page);
        const x = box.x + box.width / 2, startY = box.y + box.height - 20;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
        for (let step = 1; step <= 8; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY - step * 25 }] });
          await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await browserExpect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await cdp.detach();
      } else if (viewport.width === 1440) {
        await scroll.hover();
        await page.mouse.wheel(0, 1000);
        await browserExpect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      }
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      const measurements = await panel.evaluate(element => {
        const scroll = element.querySelector('.lab-favorites-scroll')!;
        const last = scroll.querySelector('[data-favorite-id="favorite-19"]')!;
        return { panel: { top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop }, scroll: { bottom: scroll.getBoundingClientRect().bottom, scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight }, last: { top: last.getBoundingClientRect().top, bottom: last.getBoundingClientRect().bottom }, viewport: innerHeight };
      });
      await writeFile(new URL(`${name}-${viewport.width}.json`, output), JSON.stringify(measurements, null, 2));
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-${viewport.width}.png`, output)) });
      expect(measurements.last.bottom).toBeLessThanOrEqual(Math.min(measurements.panel.bottom, measurements.viewport));
      expect(measurements.panel.scrollHeight - measurements.panel.clientHeight).toBeLessThanOrEqual(1);
      const last = scroll.locator('[data-favorite-id="favorite-19"]');
      await last.getByRole('button', { name: /^Actions for / }).click();
      await browserExpect(page.getByRole('button', { name: 'Track', exact: true })).toBeVisible();
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 30_000);
