import { useTranslate } from '@orchardworks/agent-client-web/react';
import { reauthenticationUrl, rememberReauthenticationTarget } from '../kernel/security-client.js';

export function ReauthenticationNotice({ purpose }: { purpose?: 'permissions' | 'command' } = {}) {
  const t = useTranslate();
  return <div className="lab-reauthentication" data-purpose={purpose} role="alert">
    {purpose === 'permissions' ? <><strong>{t('sessions.reauth.permissionsTitle')}</strong><p>{t('sessions.reauth.permissionsBody')}</p></>
      : purpose === 'command' ? <><strong>{t('sessions.reauth.commandTitle')}</strong><p>{t('sessions.reauth.commandBody')}</p></>
      : <p>{t('sessions.reauth.generic')}</p>}
    <a href={reauthenticationUrl()} onClick={rememberReauthenticationTarget}>{t('sessions.reauth.signInAgain')}</a>
  </div>;
}
