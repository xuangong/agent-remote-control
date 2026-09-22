import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionStars } from '../../hooks/useSessionStars.js';
import type { StarInput } from '../../session-stars-client.js';
import { sessionKey } from '../../session-tree.js';
import { folderChoices, type FavoriteNode } from '../../favorite-tree.js';
export type FavoriteEdit = { type:'session'; session:StarInput } | {type:'create';parentId:string|null} | {type:'rename'|'move'|'delete';node:FavoriteNode};
export function FavoriteDialog({favorites, edit, onClose}: {favorites:SessionStars;edit:FavoriteEdit;onClose():void}) {
  const dialog=useRef<HTMLDialogElement>(null), label=useId();
  const previous=edit.type==='session' ? favorites.stars.find(s=>sessionKey(s)===sessionKey(edit.session)) : undefined;
  const [title,setTitle]=useState(edit.type==='rename' ? edit.node.title : '');
  const [folderId,setFolderId]=useState<string|null>(edit.type==='session' ? previous?.folderId ?? null : edit.type==='create' ? edit.parentId : edit.node.parentId);
  const [newTitle,setNewTitle]=useState(''),[creating,setCreating]=useState(false);
  const createId=useRef(crypto.randomUUID());
  const newId=useRef(crypto.randomUUID());
  const busy=!!favorites.pending || favorites.loading;
  const choices=folderChoices(favorites.folders,edit.type==='move' && edit.node.folder ? edit.node.id : undefined);
  const folderExists=choices.some(f=>f.id===folderId);
  const heading=edit.type==='session' ? previous ? 'Edit favorite' : 'Add favorite' : edit.type==='create' ? 'New folder' : edit.type==='rename' ? 'Rename folder' : edit.type==='move' ? 'Move to folder' : 'Delete folder';
  useEffect(()=>{
    const focus=document.activeElement as HTMLElement|null;
    dialog.current?.showModal();
    return ()=>{if(focus?.isConnected) focus.focus({preventScroll:true});};
  },[]);
  async function save() {
    let success=false;
    if (edit.type==='session') success=await favorites.change({type:'save-session',session:edit.session,folderId});
    else if(edit.type==='create') success=await favorites.change({type:'create-folder',id:createId.current,parentId:folderId,title:title.trim()});
    else if(edit.type==='rename') success=await favorites.change({type:'rename-folder',id:edit.node.id,title:title.trim()});
    else if(edit.type==='move') success=await favorites.change({type:'move',id:edit.node.id,parentId:folderId,beforeId:null});
    else success=await favorites.change({type:'delete-folder',id:edit.node.id});
    if(success) onClose();
  }
  async function newFolder() {
    if(await favorites.change({type:'create-folder',id:newId.current,parentId:folderId,title:newTitle.trim()})) {
      setFolderId(newId.current); newId.current=crypto.randomUUID(); setCreating(false); setNewTitle('');
    }
  }
  const deletedFolders=edit.type==='delete' ? new Set(folderChoices(favorites.folders).filter(f=>!folderChoices(favorites.folders,edit.node.id).some(other=>other.id===f.id)).map(f=>f.id)) : new Set();
  const count=favorites.stars.filter(s=>deletedFolders.has(s.folderId)).length;
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog" data-favorites-dialog aria-labelledby={label}
    onKeyDown={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} onBlur={e=>e.stopPropagation()}
    onCancel={e=>{e.preventDefault();onClose();}} onClose={onClose}>
    <header><h2 id={label}>{heading}</h2><button type="button" aria-label="Close favorite editor" onClick={onClose}>×</button></header>
    <form onSubmit={e=>{e.preventDefault();void save();}}>
      {edit.type==='session' ? <p className="lab-favorite-edit-title" title={edit.session.title}>{edit.session.title}</p> : edit.type==='move' ? <p className="lab-favorite-edit-title">{edit.node.title}</p> : null}
      {edit.type==='rename' || edit.type==='create' ? <label>Name<input autoFocus required maxLength={128} value={title} onChange={e=>setTitle(e.target.value)} /></label> : null}
      {edit.type==='delete' ? <p>Delete “{edit.node.title}” and {count} {count===1?'favorite':'favorites'}? Sessions and tracked sessions will stay available.</p> : edit.type!=='rename' ? <>
        <label>Folder<select aria-label="Folder" autoFocus={edit.type==='session'||edit.type==='move'} value={folderId??''} disabled={busy} onChange={e=>setFolderId(e.target.value||null)}>
          {!folderExists ? <option value={folderId??''} disabled>Folder no longer available</option> : null}
          {choices.map(f=><option key={f.id??'root'} value={f.id??''}>{f.label}</option>)}
        </select></label>
        {edit.type!=='create' ? creating ? <div className="lab-favorite-new-folder"><label>New folder name<input autoFocus maxLength={128} value={newTitle} onChange={e=>setNewTitle(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();if(newTitle.trim())void newFolder();}}}/></label><div>
          <button type="button" disabled={busy||!newTitle.trim()||!folderExists} onClick={()=>void newFolder()}>Create folder</button><button type="button" onClick={()=>setCreating(false)}>Cancel new folder</button></div></div>
          : <button type="button" className="lab-favorite-text-action" onClick={()=>setCreating(true)}>＋ New folder</button> : null}
      </> : null}
      {favorites.error ? <p role="alert" className="lab-control-note">{favorites.error}</p> : null}
      <footer>{previous && edit.type==='session' ? <button type="button" className="lab-favorite-remove" disabled={busy} onClick={async()=>{
        const {hostId,providerId,nativeSessionId}=edit.session;
        if(await favorites.change({type:'remove-session',session:{hostId,providerId,nativeSessionId}}))onClose();
      }}>Remove favorite</button> : null}<button type="button" onClick={onClose}>Cancel</button>
      <button type="submit" className="lab-favorite-primary" disabled={busy||creating||(!folderExists&&edit.type!=='delete'&&edit.type!=='rename')||((edit.type==='rename'||edit.type==='create')&&!title.trim())}>{busy?'Saving…':edit.type==='delete'?'Delete folder':edit.type==='move'?'Move':'Save'}</button></footer>
    </form>
  </dialog>,document.body);
}
