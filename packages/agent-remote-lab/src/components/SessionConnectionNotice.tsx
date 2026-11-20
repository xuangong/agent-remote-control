import type { ReactNode } from 'react';
import { errorWords, translator, type MessageKey, type Translate } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { NativeDaemonRecovery } from './NativeSessionCommands.js';
import { DirectoryError } from '../directory-client.js';

export interface SessionConnectionMessage {
  operation?: string;
  tone: 'status' | 'alert';
  message: string;
  code?: string;
  status?: number;
  requestId?: string;
  /** The original failure text when a plain-language description replaces it. */
  detail?: string;
  /** The session succession error this notice already explains; its retry belongs here. */
  successionError?: string;
}

export function sessionConnectionFailure(error: unknown, retrying: boolean, t: Translate = translator('en')): SessionConnectionMessage {
  const detail = error instanceof DirectoryError ? error : undefined;
  const code = detail?.code;
  const waiting = ['session_attach_timeout', 'session_attach_wait_timeout', 'host_timeout', 'host_offline', 'host_reconnected', 'host_busy', 'host_backpressure'].includes(code ?? '');
  const descriptions: Readonly<Record<string, MessageKey>> = {
    session_attach_timeout: 'sessions.connection.attachTimeout',
    session_attach_wait_timeout: 'sessions.connection.attachWaitTimeout',
    host_timeout: 'sessions.connection.hostTimeout',
    host_offline: 'sessions.connection.hostOffline',
    host_reconnected: 'sessions.connection.hostReconnected',
    host_busy: 'sessions.connection.hostBusy',
    host_backpressure: 'sessions.connection.hostBackpressure',
    native_file_limit: 'sessions.connection.nativeFileLimit',
    native_runtime_unavailable: 'sessions.connection.nativeUnavailable',
    native_resume_timeout: 'sessions.connection.nativeResumeTimeout',
    native_history_timeout: 'sessions.connection.nativeHistoryTimeout',
    native_request_timeout: 'sessions.connection.nativeRequestTimeout',
    session_binding_unavailable: 'sessions.connection.bindingUnavailable',
  };
  const description = code && Object.hasOwn(descriptions, code) ? t(descriptions[code]!) : errorWords(error, t, 'sessions.connection.openFailed');
  const original = error instanceof Error && error.message.trim() && error.message !== description ? error.message : undefined;
  return { tone: waiting ? 'status' : 'alert',
    message: retrying ? t('sessions.connection.retrying', { message: description }) : waiting ? t('sessions.connection.waitAndReopen', { message: description }) : description,
    code, status: detail?.status, requestId: detail?.requestId, ...(original ? { detail: original } : {}) };
}

export function SessionConnectionNotice({ notice, action }: { notice: SessionConnectionMessage; action?: ReactNode }) {
  const t = useTranslate();
  return <div className="lab-session-notice lab-control-note">
    <p role={notice.tone}>{notice.message}</p>
    {action}
    {notice.code === 'native_file_limit' ? <NativeDaemonRecovery /> : null}
    {notice.code || notice.status || notice.requestId || notice.detail ? <details>
      <summary>{t('sessions.connection.details')}</summary>
      <dl>
        <dt>{t('sessions.connection.operation')}</dt><dd>{notice.operation ?? t('sessions.connection.openExisting')}</dd>
        {notice.code ? <><dt>{t('sessions.connection.code')}</dt><dd>{notice.code}</dd></> : null}
        {notice.status ? <><dt>{t('sessions.connection.httpStatus')}</dt><dd>{notice.status}</dd></> : null}
        {notice.requestId ? <><dt>{t('sessions.connection.requestId')}</dt><dd>{notice.requestId}</dd></> : null}
        {notice.detail ? <><dt>{t('sessions.connection.detail')}</dt><dd>{notice.detail}</dd></> : null}
      </dl>
    </details> : null}
  </div>;
}

/** Shown in place of a session the Host confirmed missing; the view itself is then empty and can hold another session. */
export function MissingSessionNote({ title, host }: { title: string; host: string }) {
  const t = useTranslate();
  return <p className="lab-missing-session-note">{t('sessions.connection.missing', { title, host })}</p>;
}
