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

it('negotiates authority diagnostics without blocking older Controller log delivery', async () => {
 const { relayDiagnosticsForVersion } = await import('./relay-diagnostics.js');
 const authority = { ...event, event: 'authority_refresh_completed', reason: 'authority_timeout', leaseRemainingMs: 20000, retryDelayMs: 10000, durationMs: 5000 };
 expect(isRelayDiagnostic(authority)).toBe(true);
 const batch = parseRelayDiagnosticBatch({ entries: [event, authority] })!;
 expect(relayDiagnosticsForVersion(batch, 1)).toEqual([event]);
 expect(relayDiagnosticsForVersion(batch, 2)).toEqual(batch);
});

it('validates transport and runtime metadata and downconverts it for older Controllers', async () => {
 const { relayDiagnosticsForVersion } = await import('./relay-diagnostics.js');
 const current = { ...event, closeCode: 1006, wasClean: false, runtimeInstanceId: 'runtime-1', workerVersionId: 'version-1' };
 const started = { ...event, event: 'relay_started', reason: undefined, startReason: 'core_recovery', runtimeInstanceId: 'runtime-1', workerVersionId: 'version-1' };
 expect(isRelayDiagnostic(current)).toBe(true);
 expect(isRelayDiagnostic(started)).toBe(true);
 for (const invalid of [{ ...current, wasClean: 'false' }, { ...current, workerVersionId: 'secret\nvalue' }, { ...started, startReason: 'arbitrary error text' }]) {
   expect(isRelayDiagnostic(invalid)).toBe(false);
 }
 const batch = parseRelayDiagnosticBatch({ entries: [current, started] })!;
 expect(relayDiagnosticsForVersion(batch, 3)).toEqual(batch);
 for (const version of [1, 2]) {
   const legacy = relayDiagnosticsForVersion(batch, version);
   expect(legacy[0]).toEqual({ ...event, closeCode: 1006 });
   expect(legacy[1]).toEqual({ ...event, event: 'relay_started', reason: undefined });
 }
});
