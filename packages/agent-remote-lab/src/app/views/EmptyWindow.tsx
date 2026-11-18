// The notice of a Window without views.
import type { AppScope } from '../types.js';

export function EmptyWindow({ scope }: { readonly scope: Pick<AppScope, 'createSessionView' | 'sharedWindow'> }) {
  const { createSessionView, sharedWindow } = scope;
  return <>
        {sharedWindow && !sharedWindow.views.length ? <div className="lab-window-empty" data-testid="empty-window">
          <p>No session views</p><button type="button" onClick={createSessionView}>New session view</button>
        </div> : null}
  </>;
}
