import { expect, it } from 'vitest';
import { favoriteNodes, visibleFavoriteNodes, folderChoices, favoriteDrop } from './favorite-tree.js';
const folders = [{ id: 'a', parentId: null, title: 'Work', order: 0 }, { id: 'b', parentId: 'a', title: 'Research', order: 0 }];
const star = { favoriteId: 's', folderId: null, order: 1, hostId: 'h', providerId: 'codex', nativeSessionId: 's', title: 'Session', starredAt: 1, available: true, online: true };
it('orders folders and sessions together and exposes only expanded children', () => {
 const nodes = favoriteNodes(folders, [star]);
 expect(visibleFavoriteNodes(nodes, new Set()).map(n => n.id)).toEqual(['a','s']);
 expect(visibleFavoriteNodes(nodes, new Set(['a'])).map(n => [n.id,n.depth])).toEqual([['a',0],['b',1],['s',0]]);
});
it('offers root and full folder paths while excluding a moving folder and descendants', () => {
 expect(folderChoices(folders).map(n => n.label)).toEqual(['Favorites','Work','Work / Research']);
 expect(folderChoices(folders,'a').map(n => n.id)).toEqual([null]);
});
it('distinguishes sibling insertion from moving into a folder and rejects cycles', () => {
 const nodes = favoriteNodes(folders,[star]);
 expect(favoriteDrop(nodes,'s','a','inside')).toEqual({parentId:'a',beforeId:null});
 expect(favoriteDrop(nodes,'s','a','before')).toEqual({parentId:null,beforeId:'a'});
 expect(favoriteDrop(nodes,'a','b','inside')).toBeUndefined();
 expect(favoriteDrop(nodes,'a','s','inside')).toBeUndefined();
 expect(favoriteDrop(nodes,'b',null,'inside')).toEqual({parentId:null,beforeId:null});
});
