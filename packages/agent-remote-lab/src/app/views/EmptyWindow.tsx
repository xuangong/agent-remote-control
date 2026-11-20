// The notice of a Window without views.
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function EmptyWindow({ scope }: { readonly scope: Pick<AppScope, 'createSessionView' | 'sharedWindow'> }) {
  const { createSessionView, sharedWindow } = scope;
  const t = useTranslate();
  return <>
        {sharedWindow && !sharedWindow.views.length ? <div className="lab-window-empty" data-testid="empty-window">
          <p>{t('windows.noViews')}</p><button type="button" onClick={createSessionView}>{t('windows.newSessionView')}</button>
        </div> : null}
  </>;
}
