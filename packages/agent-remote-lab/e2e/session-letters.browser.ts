import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let script = '', css = '', url = '';
const replyEnvelope = 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/review\nPayload:\nThe transport review is complete.';
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/fixture.js' ? script : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
beforeAll(async () => {
  const source = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import './session-view-styles.ts';
    import { App } from './App.tsx'; import { SessionDirectoryClient } from './directory-client.ts';
    import { replicaState } from './test/fixtures.ts';
    const child = { nativeSessionId: 'child', title: '/root/review', status: 'idle', observation: 'live', createdAt: '2026-09-29T00:00:00Z' };
    const agent = id => ({ ...replicaState.agent, id, providerId: 'codex', runtimeInfo: { providerId: 'codex', sessionId: id, status: 'idle', ...(id === 'parent' ? {childSessions:[child]} : {}) } });
    const entries = id => Array.from({length:40}, (_, i) => {
      const seq = i + 1, task = seq === (id === 'parent' ? 38 : 3), reply = seq === 40;
      return { providerId: 'codex', seqStart: seq, seqEnd: seq, timestamp: '2026-09-29T00:00:00Z', resources:[], collapsed:[], sourceSeqRanges:[{startSeq:seq,endSeq:seq}],
        ...((task && id === 'parent') || (reply && id === 'child') ? {} : { turnId:id+'-turn' }),
        item: task ? {type:'agent_communication', messageId:'task', sender:'/root',recipient:'/root/review',text:'Review the transport.'}
        : reply ? {type:'agent_communication',messageId:'reply',sender:'/root/review',recipient:'/root',text:${JSON.stringify(replyEnvelope)}}
        : {type:'assistant_message',messageId:'work-'+seq,text:'Activity '+seq+'. This is the work after receiving the task. A longer paragraph keeps each conversation independently scrollable.'} };
    });
    const transport = {listProviders:async()=>[],createAgent:async()=>{},resumeAgent:async()=>{},
      fetchSnapshot:async id=>({protocolVersion:'1.7.0',type:'agent_snapshot',payload:agent(id)}),
      fetchTimeline:async id=>({protocolVersion:'1.7.0',type:'timeline_page',payload:{requestId:'page',agentId:id,epoch:'epoch',direction:'tail',reset:false,staleCursor:false,gap:false,window:{minSeq:1,maxSeq:40,nextSeq:41},startCursor:null,endCursor:null,entries:entries(id),hasOlder:false,hasNewer:false,error:null}}),
      connect:(id,listener)=>{queueMicrotask(()=>{listener.onOpen();listener.onMessage({protocolVersion:'1.7.0',type:'negotiated',sessionControl:true});listener.onMessage({protocolVersion:'1.7.0',type:'session_control',payload:{agentId:id,revision:'control',access:'control',available:false,token:'token'}});listener.onMessage({protocolVersion:'1.7.0',type:'agent_snapshot',payload:agent(id)});});return{close(){},send(m){if(m.type==='timeline_subscription')queueMicrotask(()=>listener.onMessage({protocolVersion:'1.7.0',type:'timeline_subscribed',payload:{requestId:m.payload.requestId,agentIds:[id]}}));if(m.type==='session_control_request')queueMicrotask(()=>listener.onMessage({protocolVersion:'1.7.0',type:'session_control',payload:{agentId:id,requestId:m.payload.requestId,revision:'control',access:'control',available:false,token:'token'}}));}};},onDiagnostic:()=>()=>{},onProtocolMessage:()=>()=>{}};
    window.letterNavigationRequests = [];
    const directory = new SessionDirectoryClient(location.origin, async (input, init) => {
      if(String(input).includes('/attach')){const b=JSON.parse(init.body);window.letterNavigationRequests.push(b.nativeSessionId);return Response.json({agentId:b.nativeSessionId,nativeSessionId:b.nativeSessionId});}
      return Response.json({items:[],workspaces:[],hasMore:false,revision:'1'});
    });
    history.replaceState(null,'','/?agent=parent');
    createRoot(document.getElementById('root')).render(<App baseUrl={location.origin} directory={directory} transport={transport}
      hostService={{hosts:async()=>({hosts:[]}),pair:async()=>{throw Error('unused')}}} />);
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    outfile: 'fixture.js', loader: { '.woff2': 'dataurl' }, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function revealHiddenLetterFromSearch(page: Page) {
  const primary = page.locator('.lab-primary-conversation');
  const view = primary.getByRole('button', { name: 'Session view options', exact: true });
  await browserExpect(primary.locator('.agent-communication-letter')).toHaveCount(2);
  await view.click();
  await page.getByRole('checkbox', { name: 'Show letters', exact: true }).uncheck();
  await view.click();
  await browserExpect(primary.locator('.agent-communication-letter')).toHaveCount(0);
  await primary.getByRole('button', { name: 'Search this session', exact: true }).click();
  await primary.getByRole('searchbox').fill('Review the transport.');
  await primary.getByLabel('Search scope').selectOption('all');
  const results = primary.locator('.agent-session-search-results button');
  await browserExpect(results).toHaveCount(1);
  await results.click();
  await browserExpect(primary.locator('[data-inspected="true"]')).toHaveAttribute('data-entry-key', /task$/);
  await browserExpect(primary.locator('.agent-communication-letter')).toHaveCount(1);
  await view.click();
  await browserExpect(primary.getByRole('checkbox', { name: 'Show letters', exact: true })).not.toBeChecked();
  await view.click();
}

for (const engine of [chromium, webkit]) it(`keeps child navigation at the content-only tail on mobile ${engine.name()}`, async () => {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(8000);
    await page.goto(url);
    await browserExpect(page).toHaveURL(/[?&]session=parent(?:&|$)/);
    const primary = page.locator('.lab-primary-conversation');
    const view = primary.getByRole('button', { name: 'Session view options', exact: true });
    await view.click();
    await primary.getByRole('radio', { name: 'Content only', exact: true }).check();
    await view.click();
    await browserExpect(primary.locator('.lab-workbench-heading')).toBeHidden();
    const children = primary.locator('details[aria-label="Session subagents"]');
    await browserExpect(children).toHaveCount(1);
    await browserExpect(children).not.toHaveAttribute('open');
    await children.locator('summary').click();
    await browserExpect(children).toHaveAttribute('open', '');
    const child = children.locator('[data-child-session-id="child"]');
    await browserExpect(child).toBeVisible();
    await page.screenshot({ path: `/tmp/arc-content-subagents-${engine.name()}-mobile.png` });
    await child.click();
    await browserExpect(page).toHaveURL(/[?&]session=child(?:&|$)/);
    await browserExpect(page.locator('.lab-side-conversation')).toHaveCount(0);
  } finally { await browser.close(); }
}, 30000);

for (const engine of [chromium, webkit]) for (const mobile of [false, true]) it(`keeps the letter title visible while toggling Details without navigation on ${mobile ? 'mobile' : 'desktop'} ${engine.name()}`, async () => {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: mobile ? { width: 402, height: 874 } : { width: 1600, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await browserExpect(page).toHaveURL(/[?&]session=parent(?:&|$)/);
    const primary = page.locator('.lab-primary-conversation');
    const letter = primary.locator('[data-entry-key$=":reply"] .agent-communication-letter');
    const body = letter.locator('.agent-letter-body');
    const details = letter.locator('details');
    const summary = details.locator('summary');
    const header = details.getByText(/Message Type: FINAL_ANSWER/);
    const title = letter.getByRole('button', { name: 'Open letter from /root/review to /root', exact: true });
    const participants = title.getByText('/root/review → /root', { exact: true });
    const timestamp = details.locator('time');
    const initialUrl = page.url();
    const expectNoNavigation = async () => {
      await browserExpect(page).toHaveURL(initialUrl);
      await browserExpect(page.locator('.lab-side-conversation')).toHaveCount(0);
      await browserExpect(primary.locator('[data-inspected="true"]')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { letterNavigationRequests: string[] }).letterNavigationRequests)).toEqual([]);
    };
    await browserExpect(body).toHaveText('The transport review is complete.');
    await browserExpect(body).toBeVisible();
    await browserExpect(summary).toHaveText('Details');
    await browserExpect(details).not.toHaveAttribute('open');
    await browserExpect(header).toBeHidden();
    await browserExpect(participants).toBeVisible();
    await browserExpect(letter.getByText('/root/review → /root', { exact: true })).toHaveCount(1);
    await browserExpect(title.locator('svg')).toBeVisible();
    await browserExpect(letter.locator('.agent-letter-envelope')).toHaveCount(1);
    await browserExpect(letter.locator('.agent-letter-footer svg')).toHaveCount(0);
    await browserExpect(timestamp).toBeHidden();
    const titleBounds = (await title.boundingBox())!, bodyBounds = (await body.boundingBox())!;
    expect(titleBounds.y + titleBounds.height).toBeLessThanOrEqual(bodyBounds.y + 1);
    expect((await letter.boundingBox())!.height).toBeLessThanOrEqual(mobile ? 120 : 110);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectNoNavigation();
    await page.screenshot({ path: `/tmp/arc-letter-payload-${engine.name()}-${mobile ? 'mobile' : 'desktop'}-collapsed.png` });
    await letter.screenshot({ path: `/tmp/arc-letter-heading-${engine.name()}-${mobile ? 'mobile' : 'desktop'}.png` });
    await summary.click();
    await browserExpect(details).toHaveAttribute('open', '');
    await browserExpect(header).toBeVisible();
    await browserExpect(header).toContainText('Task name: /root');
    await browserExpect(header).toContainText('Sender: /root/review');
    await browserExpect(participants).toBeVisible();
    await browserExpect(timestamp).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectNoNavigation();
    await header.click();
    await expectNoNavigation();
    await page.screenshot({ path: `/tmp/arc-letter-payload-${engine.name()}-${mobile ? 'mobile' : 'desktop'}-expanded.png` });
    await summary.click();
    await browserExpect(details).not.toHaveAttribute('open');
    await browserExpect(header).toBeHidden();
    await browserExpect(participants).toBeVisible();
    await browserExpect(timestamp).toBeHidden();
    await browserExpect(body).toBeVisible();
    await expectNoNavigation();
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30000);

for (const engine of [chromium, webkit]) for (const mobile of [false, true]) it(`toggles letters independently of conversation modes and remembers the choice on ${mobile ? 'mobile' : 'desktop'} ${engine.name()}`, async () => {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: mobile ? { width: 320, height: 874 } : { width: 1600, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const primary = page.locator('.lab-primary-conversation');
    const letters = primary.locator('.agent-communication-letter');
    const activity = primary.getByText('Activity 39. This is the work after receiving the task. A longer paragraph keeps each conversation independently scrollable.', { exact: true });
    const view = primary.getByRole('button', { name: 'Session view options', exact: true });
    const content = page.getByRole('radio', { name: 'Content only', exact: true });
    const simple = page.getByRole('radio', { name: 'Simple conversation', exact: true });
    const showLetters = page.getByRole('checkbox', { name: 'Show letters', exact: true });
    const expectMode = async (mode: 'preview' | 'content' | 'simple') => {
      await browserExpect(content).toBeChecked({ checked: mode === 'content' });
      await browserExpect(simple).toBeChecked({ checked: mode === 'simple' });
      await browserExpect(primary.getByRole('radio', { name: 'Preview', exact: true })).toBeChecked({ checked: mode === 'preview' });
    };
    const expectFits = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const panel = (await primary.getByRole('region', { name: 'Session view options', exact: true }).boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      const heading = (await primary.locator(mobile ? '.lab-timeline-tools' : '.lab-workbench-heading').boundingBox())!;
      expect(heading.x).toBeGreaterThanOrEqual(0);
      expect(heading.x + heading.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    };
    const waitForConversation = async () => {
      await browserExpect(page).toHaveURL(/[?&]session=parent(?:&|$)/);
      await browserExpect(activity).toBeVisible();
      await view.click();
    };
    await page.goto(url);
    await waitForConversation();
    await browserExpect(showLetters).toBeChecked();
    await browserExpect(letters).toHaveCount(2);
    await expectMode('preview');
    await showLetters.uncheck();
    for (const mode of ['preview', 'content', 'simple'] as const) {
      if (mode === 'content') await content.check();
      if (mode === 'simple') await simple.check();
      await expectMode(mode);
      await browserExpect(showLetters).not.toBeChecked();
      await browserExpect(letters).toHaveCount(0);
      await browserExpect(activity).toBeVisible();
      await showLetters.check();
      await browserExpect(showLetters).toBeChecked();
      await browserExpect(letters).toHaveCount(2);
      await browserExpect(primary.locator('[data-entry-key$=":reply"] .agent-letter-body')).toHaveText('The transport review is complete.');
      await expectMode(mode);
      await expectFits();
      await showLetters.uncheck();
      await browserExpect(letters).toHaveCount(0);
      await browserExpect(activity).toBeVisible();
      await expectMode(mode);
      if (mode === 'content') await page.screenshot({ path: `/tmp/arc-letter-toggle-${engine.name()}-${mobile ? 'mobile' : 'desktop'}-hidden.png` });
      await page.reload();
      await waitForConversation();
      await browserExpect(showLetters).not.toBeChecked();
      await browserExpect(letters).toHaveCount(0);
      await expectMode(mode);
      await expectFits();
    }
    await showLetters.check();
    await browserExpect(letters).toHaveCount(2);
    await expectMode('simple');
    await content.check();
    await expectMode('content');
    await browserExpect(showLetters).toBeChecked();
    await browserExpect(letters).toHaveCount(2);
    await primary.getByRole('radio', { name: 'Preview', exact: true }).check();
    await expectMode('preview');
    await page.reload();
    await waitForConversation();
    await browserExpect(showLetters).toBeChecked();
    await browserExpect(letters).toHaveCount(2);
    await expectMode('preview');
    await expectFits();
    await page.screenshot({ path: `/tmp/arc-letter-toggle-${engine.name()}-${mobile ? 'mobile' : 'desktop'}-visible.png` });
    if (mobile) {
      for (const width of [320, 402]) {
        await page.setViewportSize({ width, height: 874 });
        await expectFits();
        const title = page.locator('.lab-mobile-session-title');
        expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(60);
        await page.screenshot({ path: `/tmp/arc-session-heading-${width}-${engine.name()}.png` });
        await view.click();
        const more = primary.getByRole('button', { name: 'More session actions', exact: true });
        await more.click();
        await browserExpect(more).toHaveAttribute('aria-expanded', 'true');
        await primary.getByRole('button', { name: 'Share session link', exact: true }).click();
        await browserExpect(page.getByRole('dialog', { name: 'Share session', exact: true })).toBeVisible();
        await browserExpect(page.getByRole('img', { name: 'Session QR code', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Close session link', exact: true }).click();
        await browserExpect(primary.getByRole('button', { name: 'Share session link', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await browserExpect(more).toHaveAttribute('aria-expanded', 'false');
        await browserExpect(more).toBeFocused();
        await more.click();
        await title.click();
        await browserExpect(more).toHaveAttribute('aria-expanded', 'false');
        expect(await page.evaluate(() => window.scrollX)).toBe(0);
        await view.click();
      }
    }
    if (!mobile) {
      await view.click();
      await primary.getByRole('button', { name: 'Open letter from /root to /root/review', exact: true }).click();
      const side = page.locator('.lab-side-conversation');
      await browserExpect(side).toBeVisible();
      await view.click();
      await showLetters.uncheck();
      await browserExpect(letters).toHaveCount(0);
      await browserExpect(side.locator('.agent-communication-letter')).toHaveCount(2);
      await browserExpect(side).toBeVisible();
      await expectMode('preview');
      await showLetters.check();
      await browserExpect(letters).toHaveCount(2);
      await browserExpect(side.locator('.agent-communication-letter')).toHaveCount(2);
      await browserExpect(side).toBeVisible();
      await expectMode('preview');
    }
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30000);

for (const engine of [chromium, webkit]) it(`moves letters through available space and jumps only the receiving timeline in ${engine.name()}`, async () => {
  const browser = await engine.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:2200,height:1000}}); page.setDefaultTimeout(8000);
    const errors: string[]=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.goto(url);
    const primary=page.locator('.lab-primary-conversation');
    await revealHiddenLetterFromSearch(page);
    const open=primary.getByRole('button',{name:'Open letter from /root to /root/review',exact:true});
    await browserExpect(open).toBeVisible();
    await open.getByText('/root → /root/review', { exact: true }).click();
    const side=page.locator('.lab-side-conversation');
    await browserExpect(side).toBeVisible();
    await browserExpect(side.locator('[data-inspected="true"]')).toHaveAttribute('data-entry-key',/task$/);
    await primary.getByRole('button', { name: 'Close session search', exact: true }).click();
    await browserExpect(primary.locator('.agent-communication-letter')).toHaveCount(0);
    const view = primary.getByRole('button', { name: 'Session view options', exact: true });
    await view.click();
    await primary.getByRole('checkbox', { name: 'Show letters', exact: true }).check();
    await view.click();
    const card=primary.locator('.agent-communication-letter').first();
    await browserExpect(card).toHaveAttribute('data-direction','right');
    await page.waitForTimeout(260);
    const offset=await card.evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
    expect(offset).toBeGreaterThan(24);
    const box=await card.boundingBox(), slot=await card.locator('..').boundingBox();
    expect(Math.abs(box!.x+box!.width-slot!.x-slot!.width)).toBeLessThan(2);
    const primaryScroll=primary.locator('.lab-timeline-scroll');
    const sourcePosition=await primaryScroll.evaluate(e=>e.scrollTop);
    await open.click();
    await browserExpect(open).toBeEnabled();
    expect(await primaryScroll.evaluate(e=>e.scrollTop)).toBeCloseTo(sourcePosition,0);
    const sideScroll=side.locator('.lab-timeline-scroll');
    const receipt=side.locator('[data-entry-key$=":task"]');
    const receiptBox=await receipt.boundingBox(), viewport=await sideScroll.boundingBox();
    expect(Math.abs(receiptBox!.y-viewport!.y-12)).toBeLessThan(3);
    await sideScroll.evaluate(e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));});
    await primaryScroll.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
    const reply=side.getByRole('button',{name:'Open letter from /root/review to /root',exact:true});
    await reply.click();
    await browserExpect(primary.locator('[data-inspected="true"]')).toHaveAttribute('data-entry-key',/reply$/);
    await browserExpect(primary).toBeVisible(); await browserExpect(side).toBeVisible();
    await page.setViewportSize({width:1400,height:900}); await page.waitForTimeout(260);
    const narrowOffset=await card.evaluate(e=>new DOMMatrixReadOnly(getComputedStyle(e).transform).m41);
    expect(narrowOffset).toBeLessThan(offset);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.emulateMedia({reducedMotion:'reduce'});
    expect(await card.evaluate(e=>parseFloat(getComputedStyle(e).transitionDuration))).toBeLessThan(0.001);
    if(engine===chromium) await page.screenshot({path:'/tmp/arc-session-letters.png'});
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
},30000);

for (const engine of [chromium, webkit]) it(`navigates mobile letters in the current view in ${engine.name()}`, async () => {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const primary = page.locator('.lab-primary-conversation');
    await revealHiddenLetterFromSearch(page);
    await primary.getByRole('button', { name: 'Open letter from /root to /root/review', exact: true })
      .getByText('/root → /root/review', { exact: true }).click();
    await browserExpect(primary).toBeVisible();
    await browserExpect(page.locator('.lab-side-conversation')).toHaveCount(0);
    await browserExpect(primary.locator('[data-inspected="true"]')).toHaveAttribute('data-entry-key', /task$/);
    await browserExpect(page).toHaveURL(/session=child/);
    const receipt = primary.locator('[data-entry-key$=":task"]');
    const viewport = primary.locator('.lab-timeline-scroll');
    await browserExpect.poll(async () => {
      const entry = await receipt.boundingBox(), scroll = await viewport.boundingBox();
      return Math.abs(entry!.y - scroll!.y - 12);
    }).toBeLessThan(3);
    await primary.getByRole('button', { name: 'More session actions', exact: true }).click();
    await primary.getByRole('button', { name: 'Back to previous conversation', exact: true }).click();
    await browserExpect(page).toHaveURL(/session=parent/);
    await browserExpect(primary.getByRole('button', { name: 'More session actions', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await primary.getByRole('button', { name: 'More session actions', exact: true }).click();
    await primary.getByRole('button', { name: 'Forward to next conversation', exact: true }).click();
    await browserExpect(page).toHaveURL(/session=child/);
    await browserExpect(primary.getByRole('button', { name: 'More session actions', exact: true })).toHaveAttribute('aria-expanded', 'false');
    // Clicking the received task returns to the sender's copy of the same letter.
    await primary.getByRole('button', { name: 'Open letter from /root to /root/review', exact: true }).click();
    await browserExpect(page).toHaveURL(/session=parent/);
    await browserExpect(primary.locator('[data-inspected="true"]')).toHaveAttribute('data-entry-key', /task$/);
    await primary.getByRole('button', { name: 'Open letter from /root to /root/review', exact: true }).click();
    await browserExpect(page).toHaveURL(/session=child/);
    await primary.getByRole('button', { name: 'Open letter from /root/review to /root', exact: true }).click();
    await browserExpect(page).toHaveURL(/session=parent/);
    await browserExpect(primary).toBeVisible();
    await browserExpect(page.locator('.lab-side-conversation')).toHaveCount(0);
    await browserExpect(primary.locator('[data-inspected="true"]')).toHaveAttribute('data-entry-key', /reply$/);
    await primary.getByRole('button', { name: 'Open letter from /root/review to /root', exact: true }).click();
    await browserExpect(page).toHaveURL(/session=child/);
    await browserExpect(primary.locator('[data-inspected="true"]')).toHaveAttribute('data-entry-key', /reply$/);
    await browserExpect(page.locator('.lab-side-conversation')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30000);
