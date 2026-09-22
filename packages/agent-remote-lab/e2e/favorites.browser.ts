import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect as browserExpect, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { createRelayState } from '@orchardworks/agent-remote-hosted/state';
import { createFavorites } from '@orchardworks/agent-remote-hosted/favorites';
const auth={origin:'http://localhost',issuer:'https://issuer.example',secret:'s'.repeat(32)};
async function seed() {
 const state=createRelayState(auth,undefined,()=>{},()=>{}), favorites=createFavorites(state,()=>({online:true,hostName:'zhangxians-Mac-mini.local'}));
 await favorites.execute('alice',{type:'create-folder',revision:0,id:'work',parentId:null,title:'Work'});
 await favorites.execute('alice',{type:'create-folder',revision:1,id:'child',parentId:'work',title:'Research'});
 await favorites.execute('alice',{type:'save-session',revision:2,folderId:null,session:{hostId:'mac',providerId:'codex',nativeSessionId:'1',title:'核实 dsh 集成链路及 BPP 事件上报机制'}});
 await favorites.execute('alice',{type:'save-session',revision:3,folderId:null,session:{hostId:'win',providerId:'codex',nativeSessionId:'2',title:'核实 dsh 集成链路及 BPP 事件上报机制'}});
 return favorites;
}
async function drag(page:Page,source:string,target:string,ratio=.5) {
 await browserExpect(page.locator(`[data-favorite-id="${source}"] .lab-favorite-drag`)).toBeEnabled();
 const start=await page.locator(`[data-favorite-id="${source}"] .lab-favorite-drag`).boundingBox();
 const end=await page.locator(`[data-favorite-id="${target}"]`).boundingBox();
 await page.mouse.move(start!.x+start!.width/2,start!.y+start!.height/2);await page.mouse.down();
 await page.mouse.move(end!.x+end!.width/2,end!.y+end!.height*ratio,{steps:8});await page.mouse.up();
}
it.each(['chromium','webkit'] as const)('organizes favorites over HTTP with desktop and mobile controls in %s',async name=>{
 let favorites=await seed();
 const source=`import React from 'react';import{createRoot}from'react-dom/client';import{useSessionStars}from'./hooks/useSessionStars.ts';import{FavoritesList,FavoritesMenu,StarButton}from'./components/SessionFavorites.tsx';
 const tracking={sessions:[],toggle(){}};
 function App(){const favorites=useSessionStars(location.origin+'/',true);return <><h1>Favorites</h1><div className="lab-sidebar-content"><FavoritesList favorites={favorites} tracking={tracking} busy={false} onOpen={s=>document.body.dataset.open=s.nativeSessionId}/></div><FavoritesMenu title="Current session" currentSession={{hostId:'mac',providerId:'codex',nativeSessionId:'1',title:'Current session'}} favorites={favorites} tracking={tracking} busy={false} onOpen={()=>{}}/><StarButton favorites={favorites} session={{hostId:'mac',providerId:'codex',nativeSessionId:'1',title:'Current session'}}/><StarButton favorites={favorites} session={{hostId:'mac',providerId:'codex',nativeSessionId:'fresh',title:'New research'}}/></>};createRoot(document.getElementById('root')).render(<App/>);`;
 const script=(await build({stdin:{contents:source,loader:'tsx',resolveDir:fileURLToPath(new URL('../src/',import.meta.url))},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0]!.text;
 const css=await readFile(new URL('../src/app.css',import.meta.url),'utf8');
 const server=createServer(async(req,res)=>{
  if(req.url==='/v1/favorites') {
   res.setHeader('content-type','application/json');
   try { let body='';for await(const chunk of req)body+=chunk;res.end(JSON.stringify(req.method==='POST'?await favorites.execute('alice',JSON.parse(body)):favorites.list('alice'))); }
   catch(error){console.error('favorite request',error);res.statusCode=(error as any).status??500;res.end(JSON.stringify({error:(error as Error).message}));}return;
  }
  res.setHeader('content-type',req.url==='/app.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
  res.end(req.url==='/app.js'?script:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{margin:0;padding:16px}#root{width:360px;max-width:100%;margin:0 auto}h1{font-size:18px}</style><div id="root"></div><script src="/app.js"></script>`);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const engine=name==='chromium'?chromium:webkit,browser=await engine.launch({headless:true});
 try {
  await mkdir(fileURLToPath(new URL('../test-results/favorites/',import.meta.url)),{recursive:true});
  for(const width of [390,1440]) {
   favorites=await seed();
   const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(5000);
   const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
   try { await page.locator('[data-favorite-id="work"]').waitFor(); } catch(error) { console.error({errors,body:await page.locator('body').innerText()}); throw error; }
   const first=favorites.list('alice').stars[0]!.favoriteId,second=favorites.list('alice').stars[1]!.favoriteId;
   await drag(page,second,first,.05);
   await expect.poll(()=>favorites.list('alice').stars.find(s=>s.favoriteId===second)?.order).toBe(1);
   await drag(page,first,'work');
   await expect.poll(()=>favorites.list('alice').stars.find(s=>s.favoriteId===first)?.folderId).toBe('work');
   await page.getByRole('button',{name:'Actions for Work',exact:true}).click();await page.getByRole('button',{name:'Rename',exact:true}).click();
   await page.getByRole('textbox',{name:'Name',exact:true}).fill('Projects');await page.getByRole('button',{name:'Save',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'hidden'});
   expect(favorites.list('alice').folders.find(f=>f.id==='work')?.title).toBe('Projects');
   await page.locator('[data-favorite-id="work"] .lab-favorite-folder').click();
   await page.locator(`[data-favorite-id="${first}"] .lab-session-row`).click();
   expect(await page.locator('body').getAttribute('data-open')).toBe('1');
   await page.locator('[data-favorite-id="child"]').focus();await page.keyboard.press('Shift+F10');
   await page.getByRole('button',{name:'Move to…',exact:true}).click();await page.getByLabel('Folder',{exact:true}).selectOption('');await page.getByRole('button',{name:'Move',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'hidden'});expect(favorites.list('alice').folders.find(f=>f.id==='child')?.parentId).toBeNull();
   await page.getByRole('button',{name:'＋ New folder',exact:true}).click();await page.getByRole('textbox',{name:'Name',exact:true}).fill('Nested');await page.getByLabel('Folder',{exact:true}).selectOption('work');await page.getByRole('button',{name:'Save',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'hidden'});expect(favorites.list('alice').folders.find(f=>f.title==='Nested')?.parentId).toBe('work');
   await page.getByRole('button',{name:'Edit favorite Current session',exact:true}).click();expect(await page.getByLabel('Folder',{exact:true}).inputValue()).toBe('work');await page.getByRole('button',{name:'Cancel',exact:true}).click();
   const label=page.locator('.lab-sidebar-content .lab-favorite-label').filter({has:page.locator('small')}).first();
   expect(await label.evaluate(el=>el.querySelector('small')!.getBoundingClientRect().top>=el.querySelector('strong')!.getBoundingClientRect().bottom)).toBe(true);
   await page.getByRole('button',{name:'Star New research',exact:true}).click();
   expect(await page.getByLabel('Folder',{exact:true}).inputValue()).toBe('');
   await page.getByRole('dialog').getByRole('button',{name:'＋ New folder',exact:true}).click();
   await page.getByRole('textbox',{name:'New folder name',exact:true}).fill('Personal');await page.getByRole('button',{name:'Create folder',exact:true}).click();
   await browserExpect(page.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
   await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
   expect(favorites.list('alice').stars.find(s=>s.nativeSessionId==='fresh')?.folderId).toBe(favorites.list('alice').folders.find(f=>f.title==='Personal')?.id);
   await page.screenshot({path:fileURLToPath(new URL(`../test-results/favorites/tree-${name}-${width}.png`,import.meta.url)),fullPage:true});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   // Title shortcut remains open while a nested favorite editor owns focus.
   await page.getByRole('button',{name:'Favorites',exact:true}).click();
   const popover=page.locator('.lab-title-favorites');
   await popover.getByRole('button',{name:'Edit favorite Current session',exact:true}).click();
   await page.getByRole('dialog').waitFor();expect(await popover.locator('section').isVisible()).toBe(true);
   await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});expect(await popover.locator('section').isVisible()).toBe(true);
   await page.keyboard.press('Escape');expect(await popover.locator('section').count()).toBe(0);
   await page.getByRole('button',{name:'Actions for Projects',exact:true}).click();await page.getByRole('button',{name:'Delete folder…',exact:true}).click();
   expect(await page.getByRole('dialog').innerText()).toContain('1 favorite');
   await page.getByRole('dialog').getByRole('button',{name:'Delete folder',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
   await browserExpect(page.locator('.lab-favorite-node').first()).toBeFocused();
   expect(favorites.list('alice').stars.some(s=>s.favoriteId===first)).toBe(false);expect(favorites.list('alice').stars.some(s=>s.favoriteId===second)).toBe(true);
   expect(errors).toEqual([]);await page.close();
  }
  if(name==='chromium') {
   favorites=await seed();const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(5000);
   await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);await page.locator('[data-favorite-id="work"]').waitFor();
   const first=favorites.list('alice').stars[0]!.favoriteId;
   const start=await page.locator(`[data-favorite-id="${first}"] .lab-favorite-drag`).boundingBox(),target=await page.locator('[data-favorite-id="work"]').boundingBox();
   const cdp=await page.context().newCDPSession(page);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start!.x+10,y:start!.y+20}]});
   await page.locator('[data-dragging="true"]').waitFor();
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:target!.x+100,y:target!.y+target!.height/2}]});
   await page.locator('[data-favorite-id="work"][data-drop="inside"]').waitFor();
   await page.locator('[data-favorite-id="child"]').waitFor();
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await expect.poll(()=>favorites.list('alice').stars.find(s=>s.favoriteId===first)?.folderId).toBe('work');
   for(let i=0;i<24;i++)await favorites.execute('alice',{type:'create-folder',revision:favorites.list('alice').revision,id:'extra-'+i,parentId:null,title:'Folder '+i});
   await page.reload();await page.locator('[data-favorite-id="extra-23"]').waitFor({state:'attached'});
   await page.locator('[data-favorite-id="work"]').focus();await page.keyboard.press('End');
   await expect.poll(()=>page.locator('.lab-favorites-scroll').evaluate(el=>el.scrollTop)).toBeGreaterThan(30);
   await page.keyboard.press('Home');
   await expect.poll(()=>page.locator('.lab-favorites-scroll').evaluate(el=>el.scrollTop)).toBeLessThan(50);
   const sourceBox=await page.locator('[data-favorite-id="work"] .lab-favorite-drag').boundingBox();
   const viewport=await page.locator('.lab-favorites-scroll').boundingBox();
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:sourceBox!.x+10,y:sourceBox!.y+20}]});await page.locator('[data-dragging="true"]').waitFor();
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:viewport!.x+100,y:viewport!.y+viewport!.height-5}]});
   await expect.poll(()=>page.locator('.lab-favorites-scroll').evaluate(el=>el.scrollTop)).toBeGreaterThan(30);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await page.locator('[data-dragging="true"]').waitFor({state:'detached'});
   expect(favorites.list('alice').folders.find(f=>f.id==='work')?.parentId).toBeNull();
   await page.close();
  }
 } finally {await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},45000);
