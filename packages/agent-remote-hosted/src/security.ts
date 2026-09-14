import { randomUUID } from 'node:crypto';
import type { RelayState } from './state.js';
export interface SecurityEvent { id: string; subject: string; at: number; action: string; outcome: 'allowed' | 'denied'; hostId?: string }
/** Bounded rate windows complement durable capacity limits; audit never accepts request payloads. */
export function createSecurityPolicy(state: RelayState) {
  const windows = new Map<string, { count: number; end: number }>();
  return {
    recent(authenticatedAt?: number): boolean {
      return typeof authenticatedAt === 'number' && Number.isFinite(authenticatedAt) && authenticatedAt <= Date.now() && authenticatedAt > Date.now() - 600_000;
    },
    allow(key: string, limit: number, durationMs: number): boolean {
      const now = Date.now();
      for (const [key, value] of windows) if (value.end <= now) windows.delete(key);
      let window = windows.get(key);
      if (!window) {
        if (windows.size >= 8192) return false;
        window = { count: 0, end: now + durationMs }; windows.set(key, window);
      }
      return ++window.count <= limit;
    },
    async record(subject: string, action: string, outcome: SecurityEvent['outcome'], hostId?: string) {
      // Paths may describe unknown Hosts. Invalid identifiers must never poison persisted state.
      const safeHostId = hostId && hostId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(hostId) ? hostId : undefined;
      await state.mutate(draft => {
        const events = (draft.securityEvents ?? []).filter(event => event.at > Date.now() - 30 * 86400_000);
        const own = events.filter(event => event.subject === subject);
        const retired = new Set(own.slice(0, Math.max(0, own.length - 99)).map(event => event.id));
        draft.securityEvents = [...events.filter(event => !retired.has(event.id)), {id:randomUUID(),subject,at:Date.now(),action,outcome,...(safeHostId ? {hostId:safeHostId} : {})}].slice(-4096);
      });
    },
    events(subject: string) {
      return (state.read().securityEvents ?? []).filter(event => event.subject === subject && event.at > Date.now() - 30 * 86400_000).sort((a,b) => b.at - a.at || b.id.localeCompare(a.id)).slice(0,100).map(({subject: _subject, ...event}) => event);
    },
  };
}
