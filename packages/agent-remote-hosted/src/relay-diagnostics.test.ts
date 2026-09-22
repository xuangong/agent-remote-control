import { expect, it } from 'vitest';
import { isRelayDiagnostic, parseRelayDiagnosticBatch } from './relay-diagnostics.js';
const event = { id:'event', hostId:'host', relayInstanceId:'relay', timestamp:'2026-09-24T00:00:00.000Z', source:'relay', event:'host_disconnected', reason:'heartbeat_timeout' };
it('accepts bounded typed metadata and rejects arbitrary payloads or timestamps',()=>{
 expect(isRelayDiagnostic(event)).toBe(true);
 expect(parseRelayDiagnosticBatch({entries:[event]})).toEqual([event]);
 for(const value of [{...event,body:'secret'},{...event,reason:'secret'},{...event,timestamp:'yesterday'},{...event,hostId:'key\nsecret'},{...event,durationMs:-1}]) expect(isRelayDiagnostic(value)).toBe(false);
 expect(parseRelayDiagnosticBatch({entries:Array(33).fill(event)})).toBeUndefined();
 expect(parseRelayDiagnosticBatch({entries:[event],key:'secret'})).toBeUndefined();
});
