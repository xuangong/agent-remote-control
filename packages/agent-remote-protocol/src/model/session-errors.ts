import {SESSION_CAPACITY_CLOSE_CODE} from '../session-channel-wire.js';
import type {NativeRefusal, NativeSessionOwner} from '../session-control.js';
/** Public attach failures use fixed copy rather than arbitrary native error text. */
const sessionErrors: Readonly<Record<string, string>> = {
  native_file_limit: 'The shared Codex daemon reached its file descriptor limit. Review active work before restarting it on the Host computer.',
  native_runtime_unavailable: 'The native runtime connection is unavailable. Check the native daemon and the Controller socket configuration, then reopen the session.',
  native_session_unavailable: 'The native runtime could not find this session. Check the Controller log and whether the session is available in the native client.',
  native_resume_timeout: 'The native runtime did not finish resuming the session before its deadline. Check the Controller log, then reopen the session.',
  native_history_timeout: 'The native runtime did not finish reading session history before its deadline. Check the Controller log, then reopen the session.',
  native_request_timeout: 'The native runtime did not answer a request before its deadline. Check the Controller log and try again.',
  native_usage_limited: 'The native CLI reached its usage limit. Reopen the session once the limit resets.',
  native_auth_missing: 'The native CLI is not signed in on the Host computer. Sign in there, then reopen the session.',
  native_exited: 'The native CLI stopped while it worked on the session. Check the Controller log, then reopen the session.',
  native_unresponsive: 'The native CLI stopped answering. Check the Controller log, then reopen the session.',
  native_session_owned: 'This session is controlled by another native client. Take control to interrupt it and resume here.',
  native_session_released: 'This session was handed to the native CLI. Take control to reopen it here.',
  native_owner_changed: 'Native ownership changed. Refresh the session before taking control again.',
  native_owner_busy: 'Native ownership is changing. Wait briefly, then check the session.',
  native_handoff_unknown: 'Native release was not confirmed. No new writer was started. Check the Controller log before retrying.',
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

/** The fixed words of a session in use, by the reason the CLI gave. */
const inUseErrors: Readonly<Record<NativeRefusal['reason'], string>> = {
  writer_elsewhere: 'Another process is the active writer of this session, and its CLI lets one process write at a time. The conversation stays readable here; retry once that process has finished.',
  turn_running: 'The CLI is running a turn of this session and takes no other client meanwhile. Retry once the turn has ended.',
};

/** The CLI's own reason for refusing a session in use, and when to try again, when the Host gives valid ones. */
export function nativeRefusalOf(value: unknown): NativeRefusal | undefined {
  const candidate = value as { reason?: unknown; retryAfterMs?: unknown } | undefined;
  if (candidate?.reason !== 'writer_elsewhere' && candidate?.reason !== 'turn_running') return undefined;
  const wait = candidate.retryAfterMs;
  return { reason: candidate.reason, ...(Number.isSafeInteger(wait) && (wait as number) >= 0 ? { retryAfterMs: wait as number } : {}) };
}

export function sessionAttachFailure(body: string): { code: string; error: string; nativeOwner?: NativeSessionOwner; nativeRefusal?: NativeRefusal; resetsAt?: number } {
  let code: unknown, owner: unknown, value: unknown;
  try { value = JSON.parse(body); code = (value as { code?: unknown } | null)?.code; owner = (value as { nativeOwner?: unknown } | null)?.nativeOwner; } catch { /* Older Hosts may return a non-JSON failure. */ }
  const candidate = owner as Partial<NativeSessionOwner> | undefined;
  const nativeOwner = candidate && (candidate.kind === 'native_cli' || candidate.kind === 'controller') && typeof candidate.generation === 'string' && /^[a-f\d-]{36}$/i.test(candidate.generation)
    ? {kind: candidate.kind, generation: candidate.generation} : undefined;
  const nativeRefusal = code === 'session_in_use' ? nativeRefusalOf(value) : undefined;
  if (nativeRefusal) return { code: 'session_in_use', error: inUseErrors[nativeRefusal.reason], nativeRefusal };
  // A usage limit keeps the time it resets, when the Host gives a valid one (gap 3).
  const resetsAt = (value as { resetsAt?: unknown } | null)?.resetsAt;
  const reset = code === 'native_usage_limited' && Number.isSafeInteger(resetsAt) && (resetsAt as number) >= 0 ? { resetsAt: resetsAt as number } : {};
  if (typeof code === 'string' && Object.hasOwn(sessionErrors, code)) return { code, error: sessionErrors[code]!, ...(['native_session_owned','native_session_released','native_owner_changed'].includes(code) && nativeOwner ? {nativeOwner} : {}), ...reset };
  return { code: 'session_attach_failed', error: sessionErrors.session_attach_failed! };
}

/** Missing and inaccessible bindings deliberately share the same response. */
export function unavailableRoute(path: string): { code: string; error: string } {
  return /^\/v1\/sessions\/[^/]+(?:\/|$)/.test(path)
    ? { code: 'session_binding_unavailable', error: 'This session link has no accessible remote binding. Open the session from the Host session list; if it is missing, check your Host access.' }
    : { code: 'route_not_found', error: 'This Remote Host route is unavailable. Refresh the page and check that the client and Relay versions are compatible.' };
}

/**
 * A refused subscription closes with 1008 when retrying cannot help and 1013 when it may, carrying the public reason.
 * Stream capacity has its own code so clients can say why the session waits instead of only reconnecting.
 */
export async function sessionSubscriptionRefusal(response: Response | undefined): Promise<{ code: number; reason: string }> {
  const status = response?.status ?? 404;
  let reason = 'Session subscription is unavailable.';
  try {
    const error = (await response?.json() as { error?: unknown } | undefined)?.error;
    if (typeof error === 'string' && error.trim()) reason = error.length > 240 ? `${error.slice(0, 237)}...` : error;
  } catch { /* Bodyless and non-JSON refusals keep the generic reason. */ }
  return { code: status === 429 ? SESSION_CAPACITY_CLOSE_CODE : status >= 500 || status === 408 ? 1013 : 1008, reason };
}
