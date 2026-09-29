import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect as browserExpect } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let script = '', css = '', url = '';
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/fixture.js' ? script : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
beforeAll(async () => {
  const source = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { App } from './App.tsx'; import { SessionDirectoryClient } from './directory-client.ts';
    import { replicaState } from './test/fixtures.ts';
    const child = { nativeSessionId: 'child', title: '/root/review', status: 'idle', observation: 'live', createdAt: '2026-09-29T00:00:00Z' };
    const agent = id => ({ ...replicaState.agent, id, providerId: 'codex', runtimeInfo: { providerId: 'codex', sessionId: id, status: 'idle', ...(id === 'parent' ? {childSessions:[child]} : {}) } });
    const entries = id => Array.from({length:40}, (_, i) => {
      const seq = i + 1, task = seq === (id === 'parent' ? 38 : 3), reply = seq === 40;
      return { providerId: 'codex', seqStart: seq, seqEnd: seq, timestamp: '2026-09-29T00:00:00Z', resources:[], collapsed:[], sourceSeqRanges:[{startSeq:seq,endSeq:seq}],
        ...((task && id === 'parent') || (reply && id === 'child') ? {} : { turnId:id+'-turn' }),
        item: task ? {type:'agent_communication', messageId:'task', sender:'/root',recipient:'/root/review',text:'Review the transport.'}
        : reply ? {type:'agent_communication',messageId:'reply',sender:'/root/review',recipient:'/root',text:'The transport review is complete.'}
        : {type:'assistant_message',messageId:'work-'+seq,text:'Activity '+seq+'. This is the work after receiving the task. A longer paragraph keeps each conversation independently scrollable.'} };
    });
    const transport = {listProviders:async()=>[],createAgent:async()=>{},resumeAgent:async()=>{},
      fetchSnapshot:async id=>({protocolVersion:'1.6.0',type:'agent_snapshot',payload:agent(id)}),
      fetchTimeline:async id=>({protocolVersion:'1.6.0',type:'timeline_page',payload:{requestId:'page',agentId:id,epoch:'epoch',direction:'tail',reset:false,staleCursor:false,gap:false,window:{minSeq:1,maxSeq:40,nextSeq:41},startCursor:null,endCursor:null,entries:entries(id),hasOlder:false,hasNewer:false,error:null}}),
      connect:(id,listener)=>{queueMicrotask(()=>{listener.onOpen();listener.onMessage({protocolVersion:'1.6.0',type:'negotiated',sessionControl:true});listener.onMessage({protocolVersion:'1.6.0',type:'session_control',payload:{agentId:id,revision:'control',access:'control',available:false,token:'token'}});listener.onMessage({protocolVersion:'1.6.0',type:'agent_snapshot',payload:agent(id)});});return{close(){},send(m){if(m.type==='timeline_subscription')queueMicrotask(()=>listener.onMessage({protocolVersion:'1.6.0',type:'timeline_subscribed',payload:{requestId:m.payload.requestId,agentIds:[id]}}));if(m.type==='session_control_request')queueMicrotask(()=>listener.onMessage({protocolVersion:'1.6.0',type:'session_control',payload:{agentId:id,requestId:m.payload.requestId,revision:'control',access:'control',available:false,token:'token'}}));}};},onDiagnostic:()=>()=>{},onProtocolMessage:()=>()=>{}};
    const directory = new SessionDirectoryClient(location.origin, async (input, init) => {
      if(String(input).includes('/attach')){const b=JSON.parse(init.body);return Response.json({agentId:b.nativeSessionId,nativeSessionId:b.nativeSessionId});}
      return Response.json({items:[],workspaces:[],hasMore:false,revision:'1'});
    });
    history.replaceState(null,'','/?agent=parent');
    createRoot(document.getElementById('root')).render(<App baseUrl={location.origin} directory={directory} transport={transport}
      hostService={{hosts:async()=>({hosts:[]}),pair:async()=>{throw Error('unused')}}} />);
  `;
  script = (await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0]!.text;
  css = (await Promise.all(['../../agent-remote-web/src/styles.css', '../src/app.css'].map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n').replace(/^@import.*$/gm, '');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

for (const engine of [chromium, webkit]) it(`moves letters through available space and jumps only the receiving timeline in ${engine.name()}`, async () => {
  const browser = await engine.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:2200,height:1000}}); page.setDefaultTimeout(8000);
    const errors: string[]=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.goto(url);
    const primary=page.locator('.lab-primary-conversation');
    const open=primary.getByRole('button',{name:'Open letter from /root to /root/review',exact:true});
    await browserExpect(open).toBeVisible();
    await open.click();
    const side=page.locator('.lab-side-conversation');
    await browserExpect(side).toBeVisible();
    await browserExpect(side.locator('[data-inspected="true"]')).toHaveAttribute('data-entry-key',/task$/);
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
