// The parts of the Workbench the first screen never shows (Settings, the Trace and the Replica Inspector) load as chunks of their own, so the
// roster and the conversation start without their code. The build stores these chunks with the app shell, and the idle preload below warms
// them after the first paint, so opening one costs no network.
import { lazy, useEffect, useState } from 'react';

const loadSettings = () => import('../features/settings/SettingsPage.js');
const loadTrace = () => import('../features/diagnostics/TraceView.js');
const loadInspector = () => import('../features/diagnostics/ReplicaInspector.js');

export const LazySettingsPage = lazy(() => loadSettings().then(module => ({ default: module.SettingsPage })));
export const LazyTraceView = lazy(() => loadTrace().then(module => ({ default: module.TraceView })));
export const LazyReplicaInspector = lazy(() => loadInspector().then(module => ({ default: module.ReplicaInspector })));

/** Loads the screens' code once the page is idle; a failed load is retried when the screen opens. */
export function useScreenPreload(): void {
  useEffect(() => {
    const load = () => { for (const loader of [loadSettings, loadTrace, loadInspector]) loader().catch(() => undefined); };
    const idle = (window as { requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number }).requestIdleCallback;
    if (idle) { idle(load, { timeout: 3000 }); return undefined; }
    const timer = setTimeout(load, 1500);
    return () => clearTimeout(timer);
  }, []);
}

/** True from the first time `shown` is true on: a screen mounts when first opened and then stays, as it did when it was always mounted. */
export function useEverShown(shown: boolean): boolean {
  const [ever, setEver] = useState(shown);
  useEffect(() => { if (shown) setEver(true); }, [shown]);
  return ever || shown;
}
