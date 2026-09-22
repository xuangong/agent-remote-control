import { reauthenticationUrl, rememberReauthenticationTarget } from '../security-client.js';

export function ReauthenticationNotice({ purpose }: { purpose?: 'permissions' } = {}) {
  return <div className="lab-reauthentication" data-purpose={purpose} role="alert">
    {purpose === 'permissions' ? <><strong>Sign in to change permissions</strong><p>Return to this session, then retry your change.</p></>
      : <p>A recent gateway sign-in is required. Try the action again after signing in; it will not run automatically.</p>}
    <a href={reauthenticationUrl()} onClick={rememberReauthenticationTarget}>Sign in again</a>
  </div>;
}
