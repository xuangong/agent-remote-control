import { nativeSessionRefKey, type NativeSessionRef, type SourceBinding } from '@orchardworks/agent-remote-protocol';
import type { TpmMainRouting } from './tpm.js';
import type { SessionSuccessionService } from './session-succession-service.js';
import type { RemoteHostSessionLease } from '@orchardworks/agent-remote-relay';

/** TPM work identity stays fixed while future admissions resolve the durable primary role. */
export function successionTpmRouting(service: SessionSuccessionService, controllerId: string,
  acquire: (target: NativeSessionRef) => Promise<RemoteHostSessionLease>): TpmMainRouting {
  const same = (a: NativeSessionRef, b: NativeSessionRef) => nativeSessionRefKey(a) === nativeSessionRefKey(b);
  const lineage = (binding: SourceBinding): NativeSessionRef[] => {
    if (binding.kind === 'fixed') return [binding.source];
    const state = service.store.read(binding.roleId);
    if (!same(state.role.origin, binding.origin)) throw new Error('TPM primary role origin changed.');
    return [state.role.origin, ...state.operations.filter(operation => operation.phase === 'committed').map(operation => operation.to!)];
  };
  const routing: TpmMainRouting = {
    async bind(providerId, nativeSessionId) {
      await service.ready;
      const source = { controllerId, providerId, nativeSessionId };
      const state = service.store.all().find(state => same(state.role.origin, source) || same(state.role.current, source)
        || state.operations.some(operation => operation.phase === 'committed' && same(operation.to!, source)));
      return state ? { kind: 'primary_role', roleId: state.role.id, origin: state.role.origin } : { kind: 'fixed', source };
    },
    resolve(binding) {
      if (binding.kind === 'fixed') return { target: binding.source };
      lineage(binding);
      const role = service.store.read(binding.roleId).role;
      return { target: role.current, roleRevision: role.revision };
    },
    acquire,
    assertCurrent(binding, target, revision) {
      const current = routing.resolve(binding);
      if (!same(current.target, target) || current.roleRevision !== revision) throw new Error('TPM main-session admission changed before dispatch.');
      service.coordinator.assertAdmission(target);
    },
    async read(binding, input, assertReader = () => {}) {
      assertReader();
      await service.ready;
      if (input.cursor && typeof input.cursor === 'object') {
        const target = input.sourceRef as NativeSessionRef | undefined;
        if (!target || !lineage(binding).some(source => same(source, target))) throw new Error('Legacy timeline cursors require an authorized explicit sourceRef. Read current history again to obtain a signed cursor.');
        assertReader();
        const lease = await acquire(target);
        try {
          assertReader();
          const direction = input.direction ?? 'after';
          if (direction !== 'tail' && direction !== 'before' && direction !== 'after') throw new Error('Invalid history direction.');
          const cursor = input.cursor as {epoch?: unknown;seq?:unknown};
          if (typeof cursor.epoch !== 'string' || !Number.isSafeInteger(cursor.seq)) throw new Error('Invalid timeline cursor.');
          const limit = input.limit ?? 40;
          if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('Invalid history limit.');
          const request: Parameters<RemoteHostSessionLease['agent']['fetchTimeline']>[0] = { requestId:'tpm-succession-history', agentId:lease.agent.agentId, direction, limit:limit as number,
            cursor: {epoch:cursor.epoch,seq:cursor.seq as number} };
          const page = await (lease.agent.loadTimeline?.(request) ?? lease.agent.fetchTimeline(request));
          assertReader();
          if (input.query !== undefined && typeof input.query !== 'string') throw new Error('Invalid history query.');
          const query = (input.query as string | undefined)?.toLocaleLowerCase();
          let remaining = 48000 - 2; let truncated = false;
          const entries = page.payload.entries.filter(entry => !query || JSON.stringify(entry.item).toLocaleLowerCase().includes(query)).flatMap(entry => {
            const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
            if (bytes > remaining) { truncated = true; return []; }
            remaining -= bytes; return [entry];
          });
          const { persistence: _persistence, runtimeInfo, ...snapshot } = lease.agent.snapshot().payload;
          const { persistence: _runtimePersistence, ...runtime } = runtimeInfo;
          return { sourceRef: target, state: { ...snapshot, runtimeInfo: runtime }, page: { ...page.payload, entries }, truncated, searchScope: 'returned_page' };
        } finally { lease.release(); }
      }
      if (input.sourceRef !== undefined) throw new Error('Use signed sourceContext for contextual history.');
      const query: import('./session-reference.js').SourceHistoryQuery = {};
      for (const key of ['cursor', 'sourceContext', 'turnId', 'query'] as const) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'string') throw new Error(`Invalid history ${key}.`);
          query[key] = input[key];
        }
      }
      if (input.textOffset !== undefined) {
        if (!Number.isSafeInteger(input.textOffset) || (input.textOffset as number) < 0) throw new Error('Invalid history text offset.');
        query.textOffset = input.textOffset as number;
      }
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) throw new Error('Invalid history limit.');
      if (input.limit !== undefined) query.limit = input.cursor ? input.limit as number : Math.min(input.limit as number, 7);
      else if (!input.cursor) query.limit = 7;
      const origin = binding.kind === 'fixed' ? binding.source : binding.origin;
      assertReader();
      const history = await service.bindings(origin.providerId).readRole(binding, query, assertReader);
      assertReader();
      if (!history.sourceRef) throw new Error('Main history is missing its actual source identity.');
      assertReader();
      const lease = await acquire(history.sourceRef);
      try {
        assertReader();
        const { persistence: _persistence, runtimeInfo, ...snapshot } = lease.agent.snapshot().payload;
        const { persistence: _runtimePersistence, ...runtime } = runtimeInfo;
        return { ...history, state: { ...snapshot, runtimeInfo: runtime } };
      } finally { lease.release(); }
    },
  };
  return routing;
}
