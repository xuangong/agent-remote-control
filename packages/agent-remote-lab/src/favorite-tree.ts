import type { Folder, FavoritesSnapshot } from '@orchardworks/agent-remote-hosted/favorites';
export type FavoriteNode = { id: string; parentId: string | null; title: string; order: number; folder?: Folder; session?: FavoritesSnapshot['stars'][number] };
export function favoriteNodes(folders: readonly Folder[], stars: FavoritesSnapshot['stars']): FavoriteNode[] {
  return [...folders.map(folder => ({ ...folder, folder })), ...stars.map(session => ({ id: session.favoriteId, parentId: session.folderId, title: session.title, order: session.order, session }))];
}
export function favoriteChildren(nodes: readonly FavoriteNode[], parentId: string | null): FavoriteNode[] {
  return nodes.filter(node => node.parentId === parentId).sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
}
export function visibleFavoriteNodes(nodes: readonly FavoriteNode[], expanded: ReadonlySet<string>): Array<FavoriteNode & { depth: number; position: number; siblings: number }> {
  const result: Array<FavoriteNode & { depth: number; position: number; siblings: number }> = [];
  const visit = (parent: string | null, depth: number) => {
    if (depth > 16) return;
    const children = favoriteChildren(nodes,parent);
    children.forEach((node,index) => { result.push({...node,depth,position:index+1,siblings:children.length}); if (node.folder && expanded.has(node.id)) visit(node.id,depth+1); });
  };
  visit(null,0); return result;
}
export function folderChoices(folders: readonly Folder[], exclude?: string): Array<{id:string|null;label:string}> {
  const result: Array<{id:string|null;label:string}> = [{id:null,label:'Favorites'}];
  const visit = (parent:string|null, prefix:string, depth:number) => {
    if (depth > 16) return;
    for (const folder of [...folders].filter(f => f.parentId===parent).sort((a,b) => a.order-b.order)) {
      if (folder.id===exclude) continue;
      const label = prefix ? `${prefix} / ${folder.title}` : folder.title;
      result.push({id:folder.id,label}); visit(folder.id,label,depth+1);
    }
  };
  visit(null,'',0); return result;
}
export type FavoriteDrop = {parentId:string|null;beforeId:string|null};
export function favoriteDrop(nodes: readonly FavoriteNode[], sourceId:string, targetId:string|null, placement:'before'|'after'|'inside'): FavoriteDrop | undefined {
  const source=nodes.find(n => n.id===sourceId), target=nodes.find(n => n.id===targetId);
  if (!source || sourceId===targetId || (targetId!==null && !target) || (placement==='inside' && target && !target.folder)) return;
  const parentId = placement==='inside' ? targetId : target?.parentId ?? null;
  let parent=parentId; const seen=new Set<string>();
  while (parent) { if (parent===sourceId || seen.has(parent)) return; seen.add(parent); parent=nodes.find(n => n.id===parent)?.parentId ?? null; }
  const siblings=favoriteChildren(nodes,parentId).filter(n => n.id!==sourceId);
  const beforeId=placement==='inside' ? null : placement==='before' ? targetId : siblings[siblings.findIndex(n=>n.id===targetId)+1]?.id ?? null;
  return {parentId,beforeId};
}
