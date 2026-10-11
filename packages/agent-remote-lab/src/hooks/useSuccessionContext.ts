import { useEffect, useMemo, useReducer, useRef } from 'react';
import { nativeSessionRefKey, type NativeSessionRef, type SuccessionContextStatus } from '@orchardworks/agent-remote-protocol';
import type { SessionDirectoryClient } from '../directory-client.js';

interface SuccessionContextOptions {
  directory?: SessionDirectoryClient; operationId?: string; target?: NativeSessionRef; enabled?: boolean; refreshKey?: unknown;
}
export interface SuccessionContextView { state: SuccessionContextStatus['state'] | 'restoring' | 'unavailable'; onRetry(): void }
/** Refresh triggers request evidence; only the Host can confirm history materialization. */
export function useSuccessionContext({ directory, operationId, target, enabled = true, refreshKey }: SuccessionContextOptions): SuccessionContextView | undefined {
  const [, render] = useReducer(value => value + 1, 0);
  const targetKey = target && nativeSessionRefKey(target);
  const runtime = useMemo(() => ({ state: 'restoring' as SuccessionContextView['state'], active: false, reads: 0, lastRead: 0, refreshRequested: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined, request: undefined as AbortController | undefined,
  }), [directory, operationId, targetKey]);
  const current = useRef(runtime); current.current = runtime;
  const selected = !!operationId && !!targetKey;
  const live = () => selected && !!directory && runtime.active && current.current === runtime;
  const refresh = () => {
    if (!live() || runtime.state === 'materialized') return;
    runtime.reads = 0;
    clearTimeout(runtime.timer);
    if (runtime.request) runtime.refreshRequested = true;
    else runtime.timer = setTimeout(() => void read(), Math.max(0, 2000 - (Date.now() - runtime.lastRead)));
  };
  async function read(): Promise<void> {
    if (!live() || runtime.request || runtime.state === 'materialized' || document.visibilityState === 'hidden') return;
    const request = new AbortController(); runtime.request = request; runtime.refreshRequested = false; runtime.reads++; runtime.lastRead = Date.now();
    const currentRequest = () => live() && runtime.request === request;
    const timeout = setTimeout(() => request.abort(), 15000);
    try {
      const result = await directory!.successionAction('status', operationId!, { includeContext: true, signal: request.signal });
      if (!currentRequest()) return;
      request.signal.throwIfAborted();
      const context = result.context;
      runtime.state = context && result.record.operationId === operationId && context.operationId === operationId && nativeSessionRefKey(context.target) === targetKey
        ? context.state : 'unavailable';
    } catch {
      if (!currentRequest()) return;
      runtime.state = 'unavailable';
    } finally {
      clearTimeout(timeout);
      if (currentRequest()) {
        runtime.request = undefined;
        render();
        if (runtime.refreshRequested) refresh();
        else if (['dispatching', 'accepted', 'unknown'].includes(runtime.state) && runtime.reads < 6) runtime.timer = setTimeout(() => void read(), 10000);
      }
    }
  }
  useEffect(() => {
    runtime.active = enabled;
    void read();
    const resume = () => { if (document.visibilityState !== 'hidden') refresh(); };
    window.addEventListener('pageshow', resume); window.addEventListener('online', resume); window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      runtime.active = false; clearTimeout(runtime.timer); runtime.request?.abort(); runtime.request = undefined; runtime.refreshRequested = false;
      window.removeEventListener('pageshow', resume); window.removeEventListener('online', resume); window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [runtime, enabled]);
  const observed = useRef({ runtime, refreshKey });
  useEffect(() => {
    if (observed.current.runtime === runtime && observed.current.refreshKey !== refreshKey) refresh();
    observed.current = { runtime, refreshKey };
  }, [runtime, refreshKey]);
  return selected ? { state: runtime.state, onRetry: () => { if (live() && !runtime.request) { clearTimeout(runtime.timer); runtime.reads = 0; void read(); } } } : undefined;
}
