/** Public attach failures use fixed copy rather than arbitrary native error text. */
const sessionErrors: Readonly<Record<string, string>> = {
  native_runtime_unavailable: 'The native runtime connection is unavailable. Check the native daemon and the Controller socket configuration, then reopen the session.',
  native_resume_timeout: 'The native runtime did not finish resuming the session before its deadline. Check the Controller log, then reopen the session.',
  native_history_timeout: 'The native runtime did not finish reading session history before its deadline. Check the Controller log, then reopen the session.',
  native_request_timeout: 'The native runtime did not answer a request before its deadline. Check the Controller log and try again.',
  session_in_use: 'This session is in use by another native client. Close that client, then reopen the session.',
  local_execution_policy: 'The Controller workspace policy does not allow this session. Check its local workspace settings.',
  session_unavailable: 'The native session is unavailable. Refresh the session list and check whether it is still available in the native client.',
  session_attach_failed: 'The Host could not open the native session. Check the Controller log and reopen it from the session list.',
  session_binding_conflict: 'The session binding conflicts with an existing binding. Refresh the session list and reopen the session.',
  parent_binding_missing: 'Open the parent session before opening this child session.',
  child_attachment_unavailable: 'This provider does not support opening native child sessions.',
  host_closed: 'The Controller stopped while opening the session. Reconnect it, then reopen the session.',
  invalid_provider: 'The selected provider is unavailable on this Host. Refresh the Host and provider list.',
  workspace_unavailable: 'The session workspace is unavailable to the Controller. Check its local workspace settings.',
};

export function sessionAttachFailure(body: string): { code: string; error: string } {
  let code: unknown;
  try { code = JSON.parse(body)?.code; } catch { /* Older Hosts may return a non-JSON failure. */ }
  if (typeof code === 'string' && Object.hasOwn(sessionErrors, code)) return { code, error: sessionErrors[code]! };
  return { code: 'session_attach_failed', error: sessionErrors.session_attach_failed! };
}

/** Missing and inaccessible bindings deliberately share the same response. */
export function unavailableRoute(path: string): { code: string; error: string } {
  return /^\/v1\/sessions\/[^/]+(?:\/|$)/.test(path)
    ? { code: 'session_binding_unavailable', error: 'This session link has no accessible remote binding. Open the session from the Host session list; if it is missing, check your Host access.' }
    : { code: 'route_not_found', error: 'This Remote Host route is unavailable. Refresh the page and check that the client and Relay versions are compatible.' };
}
