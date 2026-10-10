import { isCommittedSuccessionProjection, nativeSessionRefKey, type CommittedSuccessionProjection, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import type { HostedRelayState, RelayState } from './state.js';
import { StarError } from './session-stars.js';
export interface SavedSessionSuccession extends CommittedSuccessionProjection { subject: string }
const sameRef = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionRefKey(a) === nativeSessionRefKey(b);
const identity = (item: CommittedSuccessionProjection) => JSON.stringify([item.role.id,item.role.revision,item.receipt.operationId,nativeSessionRefKey(item.receipt.from),nativeSessionRefKey(item.role.current)]);
export function validSavedSessionSuccessions(value: unknown): value is SavedSessionSuccession[] {
  if (!Array.isArray(value) || value.length > 16384) return false;
  const groups = new Map<string,SavedSessionSuccession[]>();
  for (const item of value) {
    if (!item || typeof item.subject !== 'string' || !item.subject || item.subject.length > 512) return false;
    const {subject, ...projection} = item;
    if (!isCommittedSuccessionProjection(projection)) return false;
    const key=JSON.stringify([subject,projection.role.id]); const group=groups.get(key)??[];group.push(item);groups.set(key,group);
  }
  for (const items of groups.values()) {
    if (items.length>512) return false;
    items.sort((a,b)=>a.role.revision-b.role.revision);
    const first=items[0]!;
    if (first.role.revision!==2 || !sameRef(first.role.origin,first.receipt.from)) return false;
    for(let i=1;i<items.length;i++) {
      const prior=items[i-1]!,next=items[i]!;
      if(next.role.revision!==prior.role.revision+1 || !sameRef(next.role.origin,prior.role.origin) || !sameRef(next.receipt.from,prior.role.current)) return false;
    }
  }
  return true;
}
/** Feed save only from an authenticated Controller connection; subject is its trusted owner. */
export function createSessionSuccessions(state: RelayState,
  ownsController: (authenticatedHostId: string, controllerId: string, ownerSubject: string) => boolean,
  access: (subject: string, source: NativeSessionRef) => boolean) {
  const records=(snapshot:HostedRelayState)=>snapshot.sessionSuccessions??[];
  return {
    list(subject:string,roleId:string,afterRevision=0):CommittedSuccessionProjection[] {
      if (!Number.isSafeInteger(afterRevision)||afterRevision<0) throw new StarError(400,'invalid_revision','Invalid succession replay revision.');
      return records(state.read()).filter(item=>item.subject===subject&&item.role.id===roleId&&item.role.revision>afterRevision
        &&access(subject,item.receipt.from)&&access(subject,item.role.current))
        .sort((a,b)=>a.role.revision-b.role.revision).map(({subject:_,...item})=>structuredClone(item));
    },
    async save(ownerSubject:string,authenticatedHostId:string,value:unknown):Promise<void> {
      if (!isCommittedSuccessionProjection(value)) throw new StarError(400,'invalid_succession','Invalid committed succession projection.');
      const projection=structuredClone(value);
      await state.mutate(draft=>{
        if(!ownsController(authenticatedHostId,projection.role.current.controllerId,ownerSubject)) throw new StarError(403,'owner_required','Authenticated Controller owner required.');
        if(!access(ownerSubject,projection.receipt.from)||!access(ownerSubject,projection.role.current)) throw new StarError(403,'session_forbidden','Source and successor access are required.');
        const items=draft.sessionSuccessions??=[];
        const prior=items.find(item=>item.subject===ownerSubject&&item.role.id===projection.role.id&&item.role.revision===projection.role.revision);
        if(prior) {if(identity(prior)!==identity(projection)||JSON.stringify(prior.receipt.prepared)!==JSON.stringify(projection.receipt.prepared)) throw new StarError(409,'succession_conflict','Succession revision already has a different receipt.');return;}
        items.push({...projection,subject:ownerSubject});
        if(!validSavedSessionSuccessions(items)) throw new StarError(409,'succession_lineage_invalid','Succession replay requires contiguous durable lineage.');
      });
    },
  };
}
