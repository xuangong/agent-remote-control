import { useEffect } from 'react';
import { useToast } from '../components/Toast.js';
import { runningDeploymentEntry, watchDeploymentUpdate } from '../deployment-update.js';
import { flushRecoveryWrites } from '../recovery-writes.js';

const reloadPage = () => window.location.reload();

/** Loads a newer deployment while the page is out of view; a visible page offers it and loads it once left. */
export function useDeploymentUpdate(enabled: boolean, reload: () => void = reloadPage): void {
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    const load = () => { flushRecoveryWrites(); reload(); };
    const loadWhenHidden = () => { if (document.visibilityState === 'hidden') load(); };
    const stop = watchDeploymentUpdate({ running: runningDeploymentEntry(document), onUpdate() {
      if (document.visibilityState === 'hidden') { load(); return; }
      toast?.show('deployment-update', 'Update available', 'A newer version of this site is available. It loads when you leave this page, or you can reload now.', 'info', { label: 'Reload', onClick: load });
      document.addEventListener('visibilitychange', loadWhenHidden);
    } });
    return () => { stop(); document.removeEventListener('visibilitychange', loadWhenHidden); };
  }, [enabled, toast, reload]);
}
