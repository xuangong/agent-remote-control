// Connection, succession and mutation notices above the conversations.
import { SessionConnectionNotice } from '../../components/SessionConnectionNotice.js';
import { message } from '../helpers.js';
import type { AppScope } from '../types.js';

export function WorkspaceNotices({ scope }: { readonly scope: Pick<AppScope, 'compactLayout' | 'contextOpen' | 'nativeTakeover' | 'promptMigrations' | 'sessionNotice' | 'successionFailure' | 'successionNotice' | 'successionRetry' | 'uncertainMutation'> }) {
  const { compactLayout, contextOpen, nativeTakeover, promptMigrations, sessionNotice, successionFailure, successionNotice, successionRetry, uncertainMutation } = scope;
  return <>
        {sessionNotice && !nativeTakeover && !(compactLayout && contextOpen) ? <SessionConnectionNotice notice={sessionNotice} action={successionNotice ? successionRetry : undefined} /> : null}
        {successionFailure && !successionNotice ? <SessionConnectionNotice notice={{ tone: 'alert', message: successionFailure }} action={successionRetry} /> : null}
        {promptMigrations.notice}
        {uncertainMutation ? <p className="lab-control-note" role="alert">The previous action may have completed before the connection was interrupted. Its result is unknown. It will not be replayed automatically.</p> : null}
  </>;
}
