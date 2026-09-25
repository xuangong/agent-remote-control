import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { FavoritesList, StarButton } from './SessionFavorites.js';
import type { SessionStars } from '../hooks/useSessionStars.js';
import type { SessionTracking } from '../hooks/useSessionTracking.js';
const star = { favoriteId:'s',folderId:'a',order:0,hostId:'h',providerId:'codex',nativeSessionId:'n',title:'Research',starredAt:1,available:true,online:true };
const tracking = { sessions:[],toggle:vi.fn() } as unknown as SessionTracking;
function fixture(): SessionStars { return {enabled:true,ready:true,scope:'test',revision:1,stars:[star],folders:[{id:'a',parentId:null,title:'Work',order:0}],loading:false,pending:undefined,error:undefined,refresh:vi.fn(),toggle:vi.fn(),change:vi.fn(async()=>true)}; }
const button = (root:ParentNode,name:string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name)!;
beforeEach(() => { localStorage.clear(); Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('expands folders, opens sessions, and renames a folder without changing its identity', async()=>{
 const favorites=fixture(),open=vi.fn(); const view=await render(<FavoritesList favorites={favorites} tracking={tracking} busy={false} onOpen={open}/>);
 expect(view.textContent).toContain('Work'); expect(view.textContent).not.toContain('Research');
 await act(async()=>button(view,'Work').click());
 await act(async()=>view.querySelector<HTMLButtonElement>('.lab-session-row')!.click()); expect(open).toHaveBeenCalledWith(star);
 await act(async()=>view.querySelector<HTMLButtonElement>('[aria-label="Actions for Work"]')!.click());
 await act(async()=>button(document,'Rename').click());
 const input=document.querySelector<HTMLInputElement>('dialog input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Projects');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>document.querySelector('dialog form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(favorites.change).toHaveBeenCalledWith({type:'rename-folder',id:'a',title:'Projects'});
});
it('opens a folder chooser when starring and preserves the existing folder when editing', async()=>{
 const favorites=fixture();const view=await render(<StarButton session={star} favorites={favorites}/>);
 await act(async()=>view.querySelector('button')!.click());
 expect(document.querySelector<HTMLSelectElement>('dialog select')!.value).toBe('a');
 expect(document.querySelector('dialog')!.textContent).toContain('Remove favorite');
 await act(async()=>button(document.querySelector('dialog')!,'Remove favorite').click());
 expect(favorites.change).toHaveBeenCalledWith({type:'remove-session',session:{hostId:'h',providerId:'codex',nativeSessionId:'n'}});
});

it.each(['codex','copilot','claude'])('renames a %s favorite through its Host and keeps rejected input editable', async providerId=>{
 const favorites=fixture(); favorites.stars=[{...star,providerId,canRename:true}];
 const requests: any[]=[];
 vi.stubGlobal('fetch',async(url:URL,init:RequestInit)=>{requests.push({url:String(url),body:JSON.parse(String(init.body))});return Response.json({error:'Native rename failed.'},{status:503});});
 favorites.scope='https://relay.example/account/';
 const view=await render(<FavoritesList favorites={favorites} tracking={tracking} busy={false} onOpen={()=>{}}/>);
 await act(async()=>button(view,'Work').click());
 await act(async()=>view.querySelector<HTMLButtonElement>('[aria-label="Actions for Research"]')!.click());
 expect(button(document,'Rename session…')).toBeDefined();
 await act(async()=>button(document,'Rename session…').click());
 const input=document.querySelector<HTMLInputElement>('dialog input')!;
 expect(input.value).toBe('Research');
 expect(input.maxLength).toBe(providerId==='copilot'?100:512);
 expect(document.querySelector('dialog')!.textContent).toContain(providerId==='claude'?'Claude Code':providerId==='copilot'?'GitHub Copilot':'Codex');
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'New name');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>document.querySelector('dialog form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(requests[0]).toMatchObject({url:'https://relay.example/account/v1/remote/hosts/h/session/rename',body:{providerId,nativeSessionId:'n',title:'New name'}});
 expect(document.querySelector('dialog')!.textContent).toContain('Native rename failed.');expect(input.value).toBe('New name');
 await act(async()=>document.querySelector('dialog form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(requests[1].body.operationId).toBe(requests[0].body.operationId);
 vi.unstubAllGlobals();
});

it.each([false, true])('gates rename on Controller capability and connection: %s', async canRename => {
 const favorites=fixture();favorites.stars=[{...star,canRename,online:false}];
 const view=await render(<FavoritesList favorites={favorites} tracking={tracking} busy={false} onOpen={()=>{}}/>);
 await act(async()=>button(view,'Work').click());
 await act(async()=>view.querySelector<HTMLButtonElement>('[aria-label="Actions for Research"]')!.click());
 const rename=button(document,'Rename session…');
 if(canRename)expect(rename.disabled).toBe(true);else expect(rename).toBeUndefined();
});

it('filters tracked favorites across collapsed folders and untracks the exact session from its menu', async () => {
  const favorites = fixture();
  const other = { ...star, favoriteId: 'other', nativeSessionId: 'other' };
  favorites.stars.push(other);
  const toggle = vi.fn();
  const tracked = { ...tracking, sessions: [star], toggle };
  const view = await render(<FavoritesList favorites={favorites} tracking={tracked} trackedOnly busy={false} onOpen={() => {}} />);
  expect(view.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
  expect(view.querySelector('[data-favorite-id="s"]')).not.toBeNull();
  expect(view.querySelector('[data-favorite-id="other"]')).toBeNull();
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Actions for Research"]')!.click());
  await act(async () => button(document, 'Untrack').click());
  expect(toggle).toHaveBeenCalledWith(star);
});
