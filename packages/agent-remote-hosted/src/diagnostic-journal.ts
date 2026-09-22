import { randomUUID } from 'node:crypto';
import { isRelayDiagnostic, MAX_DIAGNOSTIC_BATCH, pruneRelayDiagnostics, type RelayDiagnostic, type RelayDiagnosticStore } from './relay-diagnostics.js';

type Details = Omit<RelayDiagnostic, 'id' | 'timestamp' | 'source' | 'hostId' | 'relayInstanceId'>;
type Sender = (entries: RelayDiagnostic[]) => Promise<{status: number}>;
interface Connection { send: Sender; timer?: ReturnType<typeof setTimeout>; pending: boolean; unsupported: boolean }
/** Diagnostic persistence and delivery are deliberately independent of business state commits. */
export function createDiagnosticJournal(options: {storage?: RelayDiagnosticStore; now?(): number} = {}) {
  const now = options.now ?? Date.now;
  const relayInstanceId = randomUUID();
  let entries = pruneRelayDiagnostics(options.storage?.initial, now());
  const connections = new Map<string, Connection>();
  let closed = false, dirty = false;
  let saving: Promise<void> | undefined;
  function persist(): Promise<void> {
    dirty = true;
    if (!saving) {
      saving = Promise.resolve().then(async()=>{
        try {
          while (dirty) {
            dirty = false; entries = pruneRelayDiagnostics(entries, now());
            try { await options.storage?.save(structuredClone(entries)); }
            catch { if (!dirty) break; /* Retry only a newer snapshot queued during this write. */ }
          }
        } finally { saving = undefined; }
      });
    }
    return saving;
  }
  function schedule(hostId: string, connection: Connection, delay = 1000) {
    if (closed || connections.get(hostId) !== connection || connection.pending || connection.unsupported || connection.timer) return;
    connection.timer=setTimeout(()=>{connection.timer=undefined;void deliver(hostId,connection);},delay);
    connection.timer.unref?.();
  }
  async function deliver(hostId: string, connection: Connection) {
    if (closed || connections.get(hostId)!==connection) return;
    entries=pruneRelayDiagnostics(entries,now());
    const batch=entries.filter(entry=>entry.hostId===hostId).slice(0,MAX_DIAGNOSTIC_BATCH);
    if(!batch.length)return;
    connection.pending=true;
    let retry=30000;
    try {
      await saving;
      if (closed || connections.get(hostId)!==connection) return;
      const response=await connection.send(structuredClone(batch));
      if (closed || connections.get(hostId)!==connection) return;
      if(response.status===404)connection.unsupported=true;
      else if(response.status===204) {
        const ids=new Set(batch.map(entry=>entry.id));entries=entries.filter(entry=>!ids.has(entry.id));
        await persist();retry=1000;
      }
    } catch { /* Keep the original batch for a later connection or retry. */ }
    finally {
      connection.pending=false;
      if(entries.some(entry=>entry.hostId===hostId))schedule(hostId,connection,retry);
    }
  }
  return {
    record(hostId:string, details:Details) {
      if(closed)return;
      const event={...details,id:randomUUID(),timestamp:new Date(now()).toISOString(),source:'relay' as const,hostId,relayInstanceId};
      if(!isRelayDiagnostic(event))return;
      entries=pruneRelayDiagnostics([...entries,event],now());void persist();
      const connection=connections.get(hostId);if(connection)schedule(hostId,connection);
    },
    connect(hostId:string,send:Sender) {
      const previous=connections.get(hostId);if(previous)clearTimeout(previous.timer);
      const connection:Connection={send,pending:false,unsupported:false};connections.set(hostId,connection);schedule(hostId,connection);
      return ()=>{clearTimeout(connection.timer);if(connections.get(hostId)===connection)connections.delete(hostId);};
    },
    async flush() { while (saving) await saving; },
    async close() {
      closed=true;for(const connection of connections.values())clearTimeout(connection.timer);connections.clear();while(saving)await saving;
    },
  };
}
export type DiagnosticJournal = ReturnType<typeof createDiagnosticJournal>;
