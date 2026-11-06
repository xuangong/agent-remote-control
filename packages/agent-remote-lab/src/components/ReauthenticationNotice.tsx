import { reauthenticationUrl, rememberReauthenticationTarget } from '../security-client.js';

export function ReauthenticationNotice({ purpose }: { purpose?: 'permissions' | 'command' } = {}) {
  return <div className="lab-reauthentication" data-purpose={purpose} role="alert">
    {purpose === 'permissions' ? <><strong>Sign in to change permissions</strong><p>Return to this session, then retry your change.</p></>
      : purpose === 'command' ? <><strong>Sign in to continue</strong><p>This command changes session permissions, which needs a recent sign-in. Return to this session, then run it again.</p></>
      : <p>A recent sign-in is required. Try the action again after signing in; it will not run automatically.</p>}
    <a href={reauthenticationUrl()} onClick={rememberReauthenticationTarget}>Sign in again</a>
  </div>;
}
