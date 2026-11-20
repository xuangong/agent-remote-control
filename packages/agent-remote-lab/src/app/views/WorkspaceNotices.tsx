// Connection, succession and mutation notices above the conversations.
import { SessionConnectionNotice } from '../../components/SessionConnectionNotice.js';
import { message } from '../helpers.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { AppScope } from '../types.js';

export function WorkspaceNotices({ scope }: { readonly scope: Pick<AppScope, 'compactLayout' | 'contextOpen' | 'nativeTakeover' | 'promptMigrations' | 'sessionNotice' | 'successionFailure' | 'successionNotice' | 'successionRetry' | 'uncertainMutation'> }) {
  const { compactLayout, contextOpen, nativeTakeover, promptMigrations, sessionNotice, successionFailure, successionNotice, successionRetry, uncertainMutation } = scope;
  const t = useTranslate();
  return <>
        {sessionNotice && !nativeTakeover && !(compactLayout && contextOpen) ? <SessionConnectionNotice notice={sessionNotice} action={successionNotice ? successionRetry : undefined} /> : null}
        {successionFailure && !successionNotice ? <SessionConnectionNotice notice={{ tone: 'alert', message: successionFailure }} action={successionRetry} /> : null}
        {promptMigrations.notice}
        {uncertainMutation ? <p className="lab-control-note" role="alert">{t('windows.uncertainMutation')}</p> : null}
  </>;
}
