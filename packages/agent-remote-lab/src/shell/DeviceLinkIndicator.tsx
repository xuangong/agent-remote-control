import { useContext, useLayoutEffect } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { DeviceLinkContext, type DeviceLinkNotice } from '../device-link.js';

/** Claims the page's one connection indicator while its surface is on screen; returns the link's notice, empty while the link is up. */
export function useDeviceLink(shown = true): DeviceLinkNotice | undefined {
  const link = useContext(DeviceLinkContext);
  useLayoutEffect(() => link?.claim(shown), [link?.claim, shown]);
  return link?.notice;
}

/** What the link says and offers: a status line with Retry, or Sign in again. */
export function DeviceLinkWords({ notice }: { notice: DeviceLinkNotice }) {
  const t = useTranslate();
  return <p className="lab-device-link" role="status">
    {notice.state === 'sign_in' ? <>{t('device.signIn')} <a href={notice.signIn.href} onClick={notice.signIn.onClick}>{t('device.signInAction')}</a></>
      : <>{t('device.offline')} <button type="button" onClick={notice.retry}>{t('device.retry')}</button></>}
  </p>;
}
