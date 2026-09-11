import type { AgentRuntimeInfo, AgentSession, ProviderStreamItem } from '@borgee/agent-provider-sdk';
import { DshChildSessions, DshObservationQueue, dshRuntimeObservation } from './children.js';

/** Adds native child discovery without taking ownership of the parent's runtime. */
export function withDshChildren(source: DshChildSessions, parentId: string, base: AgentSession): AgentSession {
  const queue = new DshObservationQueue<ProviderStreamItem>();
  const abort = new AbortController();
  let closed = false, observing = false, live = false;
  let children: AgentRuntimeInfo['childSessions'] = [];
  let refresh: Promise<void> | undefined;
  let dirty = false;
  let lastError: string | undefined;
  const report = (error: unknown): void => {
    if (closed) return;
    const message = `DSH child discovery unavailable: ${String(error)}`;
    if (live && message !== lastError) queue.push({ type: 'observation', sourceKey: `dsh:children-error:${parentId}:${Date.now()}`, occurredAt: Date.now(), delivery: 'live',
      event: { type: 'timeline', provider: 'dsh', item: { type: 'error', message } } });
    if (live) lastError = message;
  };
  const update = (): Promise<void> => {
    if (refresh) { dirty = true; return refresh; }
    dirty = false;
    return refresh = (async () => {
      try {
        const next = await source.list(parentId, abort.signal);
        if (closed) return;
        const changed = JSON.stringify(next) !== JSON.stringify(children);
        children = next; lastError = undefined;
        if (changed && live) queue.push(dshRuntimeObservation({ ...await base.runtimeInfo(), childSessions: children }));
      } catch (error) { report(error); }
    })().finally(() => {
      refresh = undefined;
      if (dirty && !closed) void update();
    });
  };
  const stop = source.watch((id, event, session) => {
    if (event && !['subagent/descriptor', 'turn/start', 'turn/end'].includes(event.type)) return;
    if (id === parentId || session?.header?.parentSession === parentId) void update();
  });
  const view: AgentSession = {
    get capabilities() { return base.capabilities; },
    async *observe() {
      if (observing) throw new Error('DSH parent already has an observer.');
      observing = true;
      void (async () => {
        try {
          for await (const item of base.observe()) {
            if (closed) break;
            if (item.type === 'history_boundary') { queue.push(item); live = true; void update(); }
            else if (item.event.type === 'runtime_updated') queue.push({ ...item, event: { ...item.event, runtimeInfo: { ...item.event.runtimeInfo, childSessions: children } } });
            else queue.push(item);
          }
          queue.close();
        } catch (error) { queue.close(error); }
      })();
      try { yield* queue; } finally { await view.dispose(); }
    },
    sendMessage: (text, options) => base.sendMessage(text, options),
    respondToInteraction: (id, response) => base.respondToInteraction(id, response),
    steer: base.steer?.bind(base), cancel: base.cancel?.bind(base), setPlanning: base.setPlanning?.bind(base),
    setSessionSetting: base.setSessionSetting?.bind(base), listCommands: base.listCommands?.bind(base),
    executeCommand: base.executeCommand?.bind(base), readResource: base.readResource?.bind(base),
    async runtimeInfo() { await update(); return { ...await base.runtimeInfo(), childSessions: children }; },
    async dispose() { if (closed) return; closed = true; abort.abort(); stop(); queue.close(); await base.dispose(); },
  };
  return view;
}
