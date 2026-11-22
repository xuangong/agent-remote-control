import { useEffect } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { useToast } from '../../kernel/Toast.js';
import { runningDeploymentEntry, watchDeploymentUpdate } from './deployment-update.js';
import { flushRecoveryWrites } from '../../kernel/recovery-writes.js';

const reloadPage = () => window.location.reload();

/** Loads a newer deployment while the page is out of view; a visible page offers it and loads it once left. */
export function useDeploymentUpdate(enabled: boolean, reload: () => void = reloadPage): void {
  const toast = useToast();
  const t = useTranslate();
  useEffect(() => {
    if (!enabled) return;
    const load = () => { flushRecoveryWrites(); reload(); };
    const loadWhenHidden = () => { if (document.visibilityState === 'hidden') load(); };
    const stop = watchDeploymentUpdate({ running: runningDeploymentEntry(document), onUpdate() {
      if (document.visibilityState === 'hidden') { load(); return; }
      toast?.show('deployment-update', t('client.siteUpdate.title'), t('client.siteUpdate.body'), 'info', { label: t('client.siteUpdate.reload'), onClick: load });
      document.addEventListener('visibilitychange', loadWhenHidden);
    } });
    return () => { stop(); document.removeEventListener('visibilitychange', loadWhenHidden); };
  }, [enabled, toast, reload, t]);
}
