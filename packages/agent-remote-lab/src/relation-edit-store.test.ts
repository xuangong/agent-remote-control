import { afterEach, expect, it } from 'vitest';
import { RelationEditStore } from './relation-edit-store.js';
afterEach(()=>localStorage.clear());
const edit=(operationId:string)=>({operationId,linked:false,expectedRevision:0,expectedRoleRevision:2,sourceNativeSessionId:'main'});
it('compare-and-clear checks the current persisted operation across independent stores',()=>{
 const url=new URL('http://localhost/u/owner/v1/session-relations'),first=new RelationEditStore(url),second=new RelationEditStore(url),scope='full-reader';
 first.set(scope,edit('old'));expect(second.get(scope)?.operationId).toBe('old');
 first.clear(scope,'old');first.set(scope,edit('new'));second.clear(scope,'old');
 expect(new RelationEditStore(url).get(scope)?.operationId).toBe('new');
 expect(first.get(scope)?.operationId).toBe('new');expect(second.get(scope)?.operationId).toBe('new');
});
it('does not migrate or reauthorize relation-only legacy records',()=>{
 const url=new URL('http://localhost/u/owner/v1/session-relations');
 localStorage.setItem(`agent-remote-relation-edit:${url}:side`,JSON.stringify(edit('legacy')));
 expect(new RelationEditStore(url).get('full-reader')).toBeUndefined();
});
