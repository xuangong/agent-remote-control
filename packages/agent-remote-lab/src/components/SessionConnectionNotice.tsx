import { NativeDaemonRecovery } from './NativeSessionCommands.js';
import { DirectoryError } from '../directory-client.js';

export interface SessionConnectionMessage {
  operation?: string;
  tone: 'status' | 'alert';
  message: string;
  code?: string;
  status?: number;
  requestId?: string;
}

export function sessionConnectionFailure(error: unknown, retrying: boolean): SessionConnectionMessage {
  const detail = error instanceof DirectoryError ? error : undefined;
  const code = detail?.code;
  const waiting = ['session_attach_timeout', 'session_attach_wait_timeout', 'host_timeout', 'host_offline', 'host_reconnected', 'host_busy', 'host_backpressure'].includes(code ?? '');
  const descriptions: Readonly<Record<string, string>> = {
    session_attach_timeout: 'The Relay stopped waiting for the Host to confirm opening this session. The Host may still be opening it.',
    session_attach_wait_timeout: 'The browser stopped waiting for this session to open. The Host may still be opening it.',
    host_timeout: 'The Host did not confirm opening this session before the deadline. It may still be opening.',
    host_offline: 'The Host is offline or its connection was interrupted. Waiting for it to reconnect.',
    host_reconnected: 'The Host reconnected while this session was opening. Its binding needs to be checked again.',
    host_busy: 'The Host has too many pending requests. Wait briefly before reopening this session.',
    host_backpressure: 'The Host connection is busy. Wait briefly before reopening this session.',
    native_file_limit: 'The shared Codex daemon reached its file descriptor limit. Review active work before restarting it.',
    native_runtime_unavailable: 'The native runtime connection is unavailable. Check the native daemon and the Controller socket configuration.',
    native_resume_timeout: 'The native runtime reached its deadline while resuming this session. Check the Controller log before reopening it.',
    native_history_timeout: 'The native runtime reached its deadline while reading session history. Check the Controller log before reopening it.',
    native_request_timeout: 'The native runtime did not answer a request before its deadline. Check the Controller log.',
    session_binding_unavailable: 'This session link has no accessible remote binding. Reopen it from the Host session list; if it is missing, check your Host access.',
  };
  const description = code && Object.hasOwn(descriptions, code) ? descriptions[code]! : error instanceof Error ? error.message : 'The session could not be opened.';
  return { tone: waiting ? 'status' : 'alert',
    message: description + (retrying ? ' Retrying automatically; no messages will be resent.' : waiting ? ' Wait briefly, then reopen the same session from the list.' : ''),
    code, status: detail?.status, requestId: detail?.requestId };
}

export function SessionConnectionNotice({ notice }: { notice: SessionConnectionMessage }) {
  return <div className="lab-session-notice lab-control-note">
    <p role={notice.tone}>{notice.message}</p>
    {notice.code === 'native_file_limit' ? <NativeDaemonRecovery /> : null}
    {notice.code || notice.status || notice.requestId ? <details>
      <summary>Connection details</summary>
      <dl>
        <dt>Operation</dt><dd>{notice.operation ?? 'Open existing session'}</dd>
        {notice.code ? <><dt>Code</dt><dd>{notice.code}</dd></> : null}
        {notice.status ? <><dt>HTTP status</dt><dd>{notice.status}</dd></> : null}
        {notice.requestId ? <><dt>Request ID</dt><dd>{notice.requestId}</dd></> : null}
      </dl>
    </details> : null}
  </div>;
}
