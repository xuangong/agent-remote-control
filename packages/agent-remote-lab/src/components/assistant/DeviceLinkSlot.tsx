import { useContext, useLayoutEffect } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { DeviceLinkContext } from '../../device-link.js';

/** A sidebar's foot for this device's link to the service; empty while the link is up. `shown` says whether its sidebar's mode is on screen. */
export function DeviceLinkSlot({ shown }: { shown: boolean }) {
  const link = useContext(DeviceLinkContext);
  const t = useTranslate();
  useLayoutEffect(() => link?.claim(shown), [link?.claim, shown]);
  const notice = link?.notice;
  if (!notice) return null;
  return <p className="lab-device-link" role="status">
    {notice.state === 'sign_in' ? <>{t('device.signIn')} <a href={notice.signIn.href} onClick={notice.signIn.onClick}>{t('device.signInAction')}</a></>
      : <>{t('device.offline')} <button type="button" onClick={notice.retry}>{t('device.retry')}</button></>}
  </p>;
}
