import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Button } from '../../ui/Button.js';
import './session-use.css';

export type SessionUsePhase = 'confirm' | 'working' | 'held' | 'failed';

/** Asks before a session link changes anything: the session, what would be made of it, and the terminal that may still hold it. */
export function SessionUseDialog({ title, providerId, name, phase, failure, onName, onConfirm, onTakeOver, onCancel }: {
  title: string;
  providerId: string;
  name: string;
  phase: SessionUsePhase;
  failure?: string;
  onName(value: string): void;
  onConfirm(): void;
  onTakeOver(): void;
  onCancel(): void;
}) {
  const t = useTranslate();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const working = phase === 'working';
  return createPortal(<dialog ref={dialog} className="lab-session-use-dialog" aria-label={t('sessions.use.label')} onClose={onCancel} onCancel={event => { if (working) event.preventDefault(); }}>
    <form className="lab-session-use-body" onSubmit={event => { event.preventDefault(); if (phase === 'held') onTakeOver(); else if (!working) onConfirm(); }}>
      <h2>{phase === 'held' ? t('sessions.use.heldTitle') : t('sessions.use.botTitle', { title })}</h2>
      {phase === 'held'
        ? <p className="lab-session-use-held" role="status">{t('sessions.use.held', { provider: providerId })}</p>
        : <>
          <p>{t('sessions.use.botBody')}</p>
          <label>{t('sessions.use.nameLabel')}<input value={name} maxLength={256} disabled={working} onChange={event => onName(event.target.value)} autoComplete="off" /></label>
        </>}
      {working ? <p role="status">{t('sessions.use.working')}</p> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      <div className="lab-session-use-actions">
        <Button variant="plain" disabled={working} onClick={() => dialog.current?.close()}>{t('sessions.use.cancel')}</Button>
        {phase === 'held'
          ? <Button type="submit" variant="primary" disabled={working}>{t('sessions.use.takeOver')}</Button>
          : <Button type="submit" variant="primary" disabled={working}>{t('sessions.use.confirmBot')}</Button>}
      </div>
    </form>
  </dialog>, document.body);
}
