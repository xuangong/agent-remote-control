import { reauthenticationUrl, rememberReauthenticationTarget } from '../security-client.js';

export function ReauthenticationNotice() {
  return <div className="lab-reauthentication" role="alert">
    <p>A recent gateway sign-in is required. Try the action again after signing in; it will not run automatically.</p>
    <a href={reauthenticationUrl()} onClick={rememberReauthenticationTarget}>Sign in again</a>
  </div>;
}
