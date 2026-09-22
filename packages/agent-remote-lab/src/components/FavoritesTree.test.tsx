import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { FavoritesList, StarButton } from './SessionFavorites.js';
import type { SessionStars } from '../hooks/useSessionStars.js';
import type { SessionTracking } from '../hooks/useSessionTracking.js';
const star = { favoriteId:'s',folderId:'a',order:0,hostId:'h',providerId:'codex',nativeSessionId:'n',title:'Research',starredAt:1,available:true,online:true };
const tracking = { sessions:[],toggle:vi.fn() } as unknown as SessionTracking;
function fixture(): SessionStars { return {enabled:true,scope:'test',revision:1,stars:[star],folders:[{id:'a',parentId:null,title:'Work',order:0}],loading:false,pending:undefined,error:undefined,refresh:vi.fn(),toggle:vi.fn(),change:vi.fn(async()=>true)}; }
const button = (root:ParentNode,name:string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name)!;
beforeEach(() => { localStorage.clear(); Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}}); });
afterEach(() => vi.restoreAllMocks());
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
