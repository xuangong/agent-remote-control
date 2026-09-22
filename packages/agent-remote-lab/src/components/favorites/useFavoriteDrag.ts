import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { favoriteDrop, type FavoriteNode, type FavoriteDrop } from '../../favorite-tree.js';
type Target = FavoriteDrop & { id:string|null;placement:'before'|'after'|'inside' };
type Drag = {id:string;title:string;target?:Target};
export function useFavoriteDrag(root:RefObject<HTMLDivElement>, nodes:FavoriteNode[], expand:(id:string)=>void, move:(id:string,target:FavoriteDrop)=>void) {
  const [drag,setDrag]=useState<Drag>();
  const callbacks=useRef({nodes,expand,move});callbacks.current={nodes,expand,move};
  const dragRef=useRef<Drag>();
  const active=useRef<{id:string;title:string;pointer:number;x:number;y:number;startX:number;startY:number;touch:boolean;handle:HTMLElement}>();
  const arm=useRef<ReturnType<typeof setTimeout>>(),hover=useRef<ReturnType<typeof setTimeout>>(),hoverId=useRef<string>();
  const frame=useRef<number>();const suppressClick=useRef(false);
  function clear() {
    clearTimeout(arm.current);clearTimeout(hover.current);hoverId.current=undefined;
    if(frame.current!==undefined)cancelAnimationFrame(frame.current);frame.current=undefined;
    const previous=active.current;active.current=undefined;
    if(previous?.handle.hasPointerCapture?.(previous.pointer)) previous.handle.releasePointerCapture(previous.pointer);
    dragRef.current=undefined;setDrag(undefined);
  }
  function updateTarget() {
    const pointer=active.current,current=dragRef.current,element=root.current;
    if(!pointer||!current||!element)return;
    const hit=document.elementFromPoint(pointer.x,pointer.y)?.closest<HTMLElement>('[data-favorite-id], [data-favorite-root]');
    let target:Target|undefined;
    if(hit&&element.contains(hit)) {
      const id=hit.dataset.favoriteId??null, rect=hit.getBoundingClientRect();
      const node=callbacks.current.nodes.find(n=>n.id===id), ratio=(pointer.y-rect.top)/rect.height;
      const placement=id===null?'inside':node?.folder?(ratio<.25?'before':ratio>.75?'after':'inside'):ratio<.5?'before':'after';
      const destination=favoriteDrop(callbacks.current.nodes,current.id,id,placement);
      if(destination)target={...destination,id,placement};
    }
    if(JSON.stringify(target)!==JSON.stringify(current.target)) {
      const next={...current,target};dragRef.current=next;setDrag(next);
      clearTimeout(hover.current);hoverId.current=undefined;
      if(target?.placement==='inside'&&target.id){const id=target.id;hoverId.current=id;hover.current=setTimeout(()=>callbacks.current.expand(id),600);}
    }
  }
  function scroll() {
    const pointer=active.current,element=root.current;
    if(!pointer||!dragRef.current||!element)return;
    const rect=element.getBoundingClientRect(),edge=36;
    const delta=pointer.y<rect.top+edge?-Math.min(12,(rect.top+edge-pointer.y)/3):pointer.y>rect.bottom-edge?Math.min(12,(pointer.y-rect.bottom+edge)/3):0;
    if(delta){element.scrollTop+=delta;updateTarget();}
    frame.current=requestAnimationFrame(scroll);
  }
  function activate() {
    const pointer=active.current;if(!pointer)return;
    suppressClick.current=true;const value={id:pointer.id,title:pointer.title};dragRef.current=value;setDrag(value);updateTarget();frame.current=requestAnimationFrame(scroll);
  }
  useEffect(()=>{
    const onMove=(event:PointerEvent)=>{
      const pointer=active.current;if(!pointer||event.pointerId!==pointer.pointer)return;
      pointer.x=event.clientX;pointer.y=event.clientY;
      const distance=Math.hypot(pointer.x-pointer.startX,pointer.y-pointer.startY);
      if(!dragRef.current){if(pointer.touch&&distance>10){clear();return;}if(!pointer.touch&&distance>4)activate();}
      if(dragRef.current){event.preventDefault();updateTarget();}
    };
    const onUp=(event:PointerEvent)=>{
      if(event.pointerId!==active.current?.pointer)return;
      const current=dragRef.current;
      if(current?.target)callbacks.current.move(current.id,{parentId:current.target.parentId,beforeId:current.target.beforeId});
      clear();
    };
    const cancel=()=>clear();
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&active.current){event.preventDefault();event.stopPropagation();clear();}};
    const visibility=()=>{if(document.hidden)clear();};
    document.addEventListener('pointermove',onMove,{passive:false});document.addEventListener('pointerup',onUp);document.addEventListener('pointercancel',cancel);
    document.addEventListener('keydown',key,true);document.addEventListener('visibilitychange',visibility);window.addEventListener('blur',cancel);
    return ()=>{clear();document.removeEventListener('pointermove',onMove);document.removeEventListener('pointerup',onUp);document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key,true);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('blur',cancel);};
  },[]);
  function start(event:ReactPointerEvent<HTMLButtonElement>,node:FavoriteNode) {
    if(event.button!==0||active.current)return;
    suppressClick.current=false;
    const touch=event.pointerType==='touch';
    active.current={id:node.id,title:node.title,pointer:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,touch,handle:event.currentTarget};
    event.currentTarget.setPointerCapture(event.pointerId);
    if(touch)arm.current=setTimeout(activate,400);
  }
  return {drag,start,consumeClick(){const value=suppressClick.current;suppressClick.current=false;return value;}};
}
