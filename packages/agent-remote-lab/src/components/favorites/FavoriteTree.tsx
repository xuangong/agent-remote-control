import { RenameSessionDialog } from './RenameSessionDialog.js';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionStars } from '../../hooks/useSessionStars.js';
import type { SessionTracking } from '../../hooks/useSessionTracking.js';
import type { VisibleSessionStar } from '../../session-stars-client.js';
import { sessionKey } from '../../session-tree.js';
import { favoriteChildren, favoriteNodes, visibleFavoriteNodes, type FavoriteNode } from '../../favorite-tree.js';
import { FavoriteDialog, type FavoriteEdit } from './FavoriteDialog.js';
import { useFavoriteDrag } from './useFavoriteDrag.js';
export function FavoriteIcon({folder,expanded}:{folder?:boolean;expanded?:boolean}) {
  return <svg className="lab-favorite-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    {folder ? <><path d="M3 7V5h7l2 2h9v13H3Z"/>{expanded?<path d="m6 12 4 4 4-4"/>:<path d="m8 11 4 3-4 3"/>}</> : <path d="M6 3h12v18l-6-4-6 4Z"/>}
  </svg>;
}
export function FavoriteTree({favorites,tracking,activeKey,busy,onOpen}:{favorites:SessionStars;tracking:SessionTracking;activeKey?:string;busy:boolean;onOpen(item:VisibleSessionStar):void}) {
  const storageKey=`agent-remote-favorite-folders:${favorites.scope}`;
  const [expanded,setExpanded]=useState<Set<string>>(()=>{try{const saved=JSON.parse(localStorage.getItem(storageKey)??'[]');return new Set(Array.isArray(saved)?saved.filter((id:unknown)=>typeof id==='string'):[]);}catch{return new Set();}});
  const [menu,setMenu]=useState<string>(),[edit,setEdit]=useState<FavoriteEdit>(),[focused,setFocused]=useState<string>();
  const [renameSession,setRenameSession]=useState<VisibleSessionStar>();
  const root=useRef<HTMLDivElement>(null),menuRoot=useRef<HTMLDivElement>(null);
  const nodes=favoriteNodes(favorites.folders,favorites.stars),visible=visibleFavoriteNodes(nodes,expanded);
  const disabled=!!favorites.pending||favorites.loading;
  const persist=(next:Set<string>)=>{setExpanded(next);try{localStorage.setItem(storageKey,JSON.stringify([...next]));}catch{/* Organization still works without local preferences. */}};
  const expand=(id:string)=>{if(!expanded.has(id))persist(new Set([...expanded,id]));};
  const toggle=(id:string)=>{const next=new Set(expanded);if(next.has(id))next.delete(id);else next.add(id);persist(next);};
  const drag=useFavoriteDrag(root,nodes,expand,(id,target)=>{if(!disabled)void favorites.change({type:'move',id,parentId:target.parentId,beforeId:target.beforeId});});
  const focusNode=(id:string)=>{
    const rows=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-favorite-id]')??[]);
    const target=rows.find(el=>el.dataset.favoriteId===id)??rows[0];
    setFocused(target?.dataset.favoriteId);
    if(target)target.focus();
    else root.current?.parentElement?.querySelector<HTMLButtonElement>('.lab-favorites-toolbar button')?.focus();
  };
  const menuAnchor=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-favorite-id]')??[]).find(el=>el.dataset.favoriteId===menu)?.getBoundingClientRect();
  const menuTop=menuAnchor ? Math.max(8, Math.min(menuAnchor.bottom, window.innerHeight-280)) : 0;
  const menuLeft=menuAnchor ? Math.max(8, Math.min(menuAnchor.right-170, window.innerWidth-178)) : 0;
  const closeMenu=()=>{const id=menu;setMenu(undefined);if(id)focusNode(id);};
  useEffect(()=>{
    if(!menu)return;
    menuRoot.current?.querySelector('button')?.focus({preventScroll:true});
    const dismiss=(e:PointerEvent)=>{if(e.target instanceof Node&&!menuRoot.current?.contains(e.target))setMenu(undefined);};
    const scroll=()=>setMenu(undefined);
    const element=root.current; element?.addEventListener('scroll',scroll);
    document.addEventListener('pointerdown',dismiss);return()=>{document.removeEventListener('pointerdown',dismiss);element?.removeEventListener('scroll',scroll);};
  },[menu]);
  function open(node:FavoriteNode) {if(node.folder)toggle(node.id);else if(node.session&&node.session.online&&node.session.available&&!busy)onOpen(node.session);}
  function key(event:KeyboardEvent,node:FavoriteNode,index:number) {
    if(event.target!==event.currentTarget)return;
    const k=event.key;let next:string|undefined;
    if(k==='ArrowDown')next=visible[index+1]?.id;
    else if(k==='ArrowUp')next=visible[index-1]?.id;
    else if(k==='Home')next=visible[0]?.id;
    else if(k==='End')next=visible.at(-1)?.id;
    else if(k==='ArrowRight'&&node.folder){if(!expanded.has(node.id))expand(node.id);else next=visible[index+1]?.parentId===node.id?visible[index+1]?.id:undefined;}
    else if(k==='ArrowLeft'){if(node.folder&&expanded.has(node.id))toggle(node.id);else next=node.parentId??undefined;}
    else if(k==='Enter'||k===' '){open(node);}
    else if(k==='F2'&&node.folder){setEdit({type:'rename',node});}
    else if(k==='ContextMenu'||(k==='F10'&&event.shiftKey)){setMenu(node.id);}
    else return;
    event.preventDefault();event.stopPropagation();if(next)focusNode(next);
  }
  function action(value:FavoriteEdit) {setMenu(undefined);setEdit(value);}
  const focusedId=visible.some(n=>n.id===focused)?focused:visible[0]?.id;
  return <div className="lab-favorites-manager" aria-busy={!!favorites.pending}>
    <div className="lab-favorites-toolbar"><span>{favorites.stars.length} {favorites.stars.length===1?'favorite':'favorites'}</span><button type="button" disabled={disabled} onClick={()=>setEdit({type:'create',parentId:null})}>＋ New folder</button></div>
    {!nodes.length&&!favorites.loading ? <p className="lab-control-note">Star a session or create a folder to start organizing.</p> : null}
    <div ref={root} className="lab-favorites-scroll" data-dragging={!!drag.drag}>
      <div data-favorite-root className="lab-favorite-root" data-drop={drag.drag?.target?.id===null?'inside':undefined}><FavoriteIcon folder expanded/><span>Favorites</span></div>
      <div role="tree" aria-label="Favorites folders and sessions" className="lab-favorite-tree">
        {visible.map((node,index)=>{
          const tracked=node.session&&tracking.sessions.some(s=>sessionKey(s)===sessionKey(node.session!));
          const current=node.session&&activeKey===sessionKey(node.session);
          const target=drag.drag?.target?.id===node.id?drag.drag.target.placement:undefined;
          const siblings=favoriteChildren(nodes,node.parentId),position=siblings.findIndex(n=>n.id===node.id);
          const unavailable=node.session&&(!node.session.online||!node.session.available);
          return <div key={node.id} role="treeitem" aria-label={node.title} aria-level={node.depth+1} aria-posinset={node.position} aria-setsize={node.siblings} aria-expanded={node.folder?expanded.has(node.id):undefined}
            aria-current={current?'page':undefined} tabIndex={node.id===focusedId?0:-1} onFocus={()=>setFocused(node.id)} onKeyDown={e=>key(e,node,index)} data-favorite-id={node.id}
            className="lab-favorite-node" data-current={!!current} data-drop={target} data-moving={drag.drag?.id===node.id} style={{paddingInlineStart:`${6+node.depth*14}px`}}
            onContextMenu={e=>{e.preventDefault();setMenu(node.id);}}>
            <button type="button" tabIndex={-1} className="lab-favorite-drag" title="Drag to move, or click to choose a folder" aria-label={`Move ${node.title}`} disabled={disabled}
              onPointerDown={e=>drag.start(e,node)} onClick={()=>{if(!drag.consumeClick())action({type:'move',node});}}>⠿</button>
            <button type="button" tabIndex={-1} className={node.folder?'lab-favorite-folder':'lab-session-row'} disabled={!node.folder&&(busy||!!unavailable)} onClick={()=>open(node)}
              title={node.session?`${node.title}\n${node.session.hostName??'Unavailable Host'} · ${node.session.providerId}${unavailable?' · Offline or access unavailable':''}`:node.title}>
              <FavoriteIcon folder={!!node.folder} expanded={expanded.has(node.id)}/><span className="lab-favorite-label"><strong>{node.title}</strong>{node.session?<small>{node.session.hostName??'Unavailable Host'} · {node.session.providerId}{!node.session.available?' · No access':!node.session.online?' · Offline':''}</small>:null}</span>
            </button>
            {tracked?<span className="lab-favorite-tracked" aria-label="Tracked on this device" title="Tracked on this device">◉</span>:null}
            <button type="button" className="lab-favorite-more" aria-label={`Actions for ${node.title}`} aria-expanded={menu===node.id} disabled={disabled} onClick={()=>setMenu(menu===node.id?undefined:node.id)}>⋯</button>
            {menu===node.id?createPortal(<div ref={menuRoot} data-favorites-dialog style={{top:menuTop,left:menuLeft}} onPointerDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} onBlur={e=>{e.stopPropagation();if(e.relatedTarget instanceof Node&&!e.currentTarget.contains(e.relatedTarget))setMenu(undefined);}} className="lab-favorite-menu" role="group" aria-label={`Actions for ${node.title}`} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeMenu();}}}>
              {node.folder?<><button type="button" onClick={()=>action({type:'create',parentId:node.id})}>New folder</button><button type="button" onClick={()=>action({type:'rename',node})}>Rename</button></>:<button type="button" disabled={!tracked&&!node.session!.available} onClick={()=>{tracking.toggle(node.session!);closeMenu();}}>{tracked?'Untrack':'Track'}</button>}
              {node.session?.canRename ? <button type="button" disabled={!node.session.available||!node.session.online} onClick={()=>{setMenu(undefined);setRenameSession(node.session);}}>Rename session…</button> : null}
              <button type="button" onClick={()=>action({type:'move',node})}>Move to…</button>
              <button type="button" disabled={position===0} onClick={()=>{void favorites.change({type:'move',id:node.id,parentId:node.parentId,beforeId:siblings[position-1]!.id});closeMenu();}}>Move up</button>
              <button type="button" disabled={position===siblings.length-1} onClick={()=>{void favorites.change({type:'move',id:node.id,parentId:node.parentId,beforeId:siblings[position+2]?.id??null});closeMenu();}}>Move down</button>
              <button type="button" onClick={()=>{if(node.folder)action({type:'delete',node});else {const {hostId,providerId,nativeSessionId}=node.session!;void favorites.change({type:'remove-session',session:{hostId,providerId,nativeSessionId}});closeMenu();}}}>{node.folder?'Delete folder…':'Remove favorite'}</button>
            </div>,document.body):null}
          </div>;
        })}
      </div>
    </div>
    <p className="lab-favorite-drag-status" role="status">{drag.drag ? drag.drag.target ? `Moving ${drag.drag.title}. Release to place.` : `Moving ${drag.drag.title}. Choose a folder or gap.` : ''}</p>
    {renameSession?<RenameSessionDialog favorites={favorites} session={renameSession} onClose={()=>{setRenameSession(undefined);requestAnimationFrame(()=>focusNode(renameSession.favoriteId!));}}/>:null}
    {edit?<FavoriteDialog favorites={favorites} edit={edit} onClose={()=>{const id=edit&&'node' in edit?edit.node.id:undefined;setEdit(undefined);requestAnimationFrame(()=>{if(id)focusNode(id);else root.current?.parentElement?.querySelector<HTMLButtonElement>('.lab-favorites-toolbar button')?.focus();});}}/>:null}
  </div>;
}
