import { useId, type ReactNode } from 'react';
import { PROCESS_MODES, type ProcessMode, type SessionFile } from '@orchardworks/agent-client';
import type { BotPicture } from '@orchardworks/agent-remote-protocol';
import type { AvatarMood } from '@orchardworks/agent-client-web/theme';
import { SegmentedControl, Sheet, Toggle } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { MenuEntry } from '../../ui/Menu.js';
import type { ProcessModeChoice } from '../../hooks/useProcessMode.js';
import type { AssistantWhere } from './details-host.js';
import { AssistantCard } from './AssistantCard.js';
import { WhereItWorks } from './WhereItWorks.js';
import { SessionsList, type AssistantSessions } from './SessionsList.js';
import { FilesList } from './FilesList.js';
import './assistant.css';

/** Everything the details show of one assistant; each section shows only when its part is known. */
export interface AssistantRef {
  readonly id: string; readonly picture?: BotPicture; readonly name: string; readonly label?: string; readonly role?: string; readonly mood?: AvatarMood;
  readonly actions?: readonly MenuEntry[]; readonly setPicture?: (picture: BotPicture) => void;
  readonly where?: AssistantWhere;
  readonly sessions?: AssistantSessions;
  readonly process?: ProcessModeChoice;
  readonly letters?: { readonly visible: boolean; set(visible: boolean): void };
  /** This device's notifications, which every assistant shares. */
  readonly notifications?: { readonly enabled: boolean; readonly available: boolean; set(enabled: boolean): void };
  readonly settings?: ReactNode;
  readonly files?: readonly SessionFile[];
  readonly openFile?: (file: SessionFile, trigger: HTMLElement) => void;
}

/**
 * The details of an assistant (I3 plan, section 4.5), one component for both modes: its card, where it works, the process
 * mode for it and for this device, notifications, model and settings, and its files. A panel beside the conversation or
 * over a window, or a sheet on a phone.
 */
export function AssistantDetails({ assistant, surface, onClose }: { assistant: AssistantRef; surface: 'panel' | 'sheet'; onClose(): void }) {
  const t = useTranslate();
  const id = useId();
  const options = PROCESS_MODES.map(mode => ({ value: mode, label: t(`process.${mode}` as const) }));
  const section = (key: string, title: string, children: ReactNode) => <section className="lab-assistant-section" aria-labelledby={`${id}-${key}`}>
    <h3 id={`${id}-${key}`}>{title}</h3>{children}</section>;
  const body = <div className="lab-assistant-details-body">
    <AssistantCard id={assistant.id} {...(assistant.picture ? { picture: assistant.picture } : {})} name={assistant.name} {...(assistant.label ? { label: assistant.label } : {})}
      {...(assistant.role ? { role: assistant.role } : {})} {...(assistant.mood ? { mood: assistant.mood } : {})} {...(assistant.actions ? { actions: assistant.actions } : {})}
      {...(assistant.setPicture ? { setPicture: assistant.setPicture } : {})} />
    {assistant.where || assistant.sessions ? section('where', t('details.where'), <WhereItWorks {...(assistant.where ? { where: assistant.where } : {})}
      sessions={assistant.sessions ? <SessionsList sessions={assistant.sessions} /> : undefined} />) : null}
    {assistant.process ? section('process', t('process.heading'), <div className="lab-assistant-process">
      {assistant.process.chooseForAssistant ? <div className="lab-process-choice"><span>{t('process.assistant')}</span>
        <SegmentedControl<ProcessMode> label={t('process.assistant')} options={options} value={assistant.process.mode} onChange={assistant.process.chooseForAssistant} /></div> : null}
      <div className="lab-process-choice"><span>{t('process.device')}</span>
        <SegmentedControl<ProcessMode> label={t('process.device')} options={options} value={assistant.process.device} onChange={assistant.process.chooseForDevice} /></div>
      {assistant.letters ? <Toggle label={t('process.letters')} checked={assistant.letters.visible} onChange={assistant.letters.set} /> : null}
    </div>) : null}
    {assistant.notifications ? section('notifications', t('details.notifications'), <div className="lab-assistant-group">
      <Toggle label={t('details.notify')} checked={assistant.notifications.enabled} disabled={!assistant.notifications.available} onChange={assistant.notifications.set} /></div>) : null}
    {assistant.settings ? section('model', t('details.model'), <div className="lab-assistant-settings">{assistant.settings}</div>) : null}
    {assistant.files ? section('files', t('details.files'), <FilesList files={assistant.files} {...(assistant.openFile ? { onOpen: assistant.openFile } : {})} />) : null}
  </div>;
  return surface === 'sheet' ? <Sheet open title={assistant.name} detent="large" onClose={onClose}>{body}</Sheet> : body;
}
