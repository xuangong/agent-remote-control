import { useState } from 'react';
import { errorWords } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/** Whether a standing bot is the person's primary bot, whether it can be (it reports to the person), and the change. */
export interface PrimaryChoice {
  readonly current: boolean;
  readonly eligible: boolean;
  set(primary: boolean): Promise<void>;
}

export function PrimaryControl({ primary }: { primary: PrimaryChoice }) {
  const t = useTranslate();
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const change = async (value: boolean) => {
    if (pending) return;
    setPending(true); setError(undefined);
    try { await primary.set(value); } catch (reason) { setError(errorWords(reason, t, 'details.primaryRefused')); } finally { setPending(false); }
  };
  return <div className="lab-assistant-process" data-primary={primary.current || undefined}>
    <p className="lab-assistant-hint">{primary.current ? t('details.primaryIs') : primary.eligible ? t('details.primaryHint') : t('details.primaryRefused')}</p>
    {primary.current || primary.eligible ? <button type="button" className="lab-assistant-action" disabled={pending} onClick={() => void change(!primary.current)}>
      {t(primary.current ? 'details.clearPrimary' : 'details.makePrimary')}</button> : null}
    {error ? <p role="alert" className="lab-assistant-hint">{error}</p> : null}
  </div>;
}
