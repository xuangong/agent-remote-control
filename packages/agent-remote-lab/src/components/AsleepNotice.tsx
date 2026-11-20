import { useTranslate } from '@orchardworks/agent-client-web/react';

/** A sleeping bot: quiet, with Wake, which wakes it for every device. Its conversation is released until then. */
export function AsleepNotice({ onWake }: { onWake(): void }) {
  const t = useTranslate();
  return <p className="lab-bot-asleep" role="status">{t('sessions.asleep.note')}{' '}
    <button type="button" onClick={onWake}>{t('sessions.asleep.wake')}</button></p>;
}
