import { useId, type ReactNode } from 'react';
import { PROCESS_MODES, type ProcessMode, type SessionFile } from '@orchardworks/agent-client';
import type { BotPicture, TaskView, WorkItem } from '@orchardworks/agent-remote-protocol';
import type { AvatarMood } from '@orchardworks/agent-client-web/theme';
import { SegmentedControl, Sheet } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { MenuEntry } from '../../ui/Menu.js';
import type { ProcessModeChoice } from '../useProcessMode.js';
import type { AssistantWhere } from './details-host.js';
import { AssistantCard, type CardAction } from './AssistantCard.js';
import { WhereItWorks } from './WhereItWorks.js';
import { SessionsList, type AssistantSessions } from './SessionsList.js';
import { FilesList } from './FilesList.js';
import { TasksList } from './TasksList.js';
import { WorkList } from './WorkList.js';
import { MissionEditor, type MissionChoice } from './MissionEditor.js';
import './assistant.css';

/** Everything the details show of one assistant; each section shows only when its part is known. */
export interface AssistantRef {
  readonly id: string; readonly picture?: BotPicture; readonly name: string; readonly label?: string; readonly role?: string; readonly mood?: AvatarMood;
  /** The card's one visible action, and the others in its ⋯ menu. */
  readonly action?: CardAction; readonly actions?: readonly MenuEntry[]; readonly setPicture?: (picture: BotPicture) => void;
  /** Stores the assistant's own name; absent where the name cannot be stored. */
  readonly rename?: (name: string) => void;
  readonly where?: AssistantWhere;
  readonly sessions?: AssistantSessions;
  /** The tasks the session on screen owns. */
  readonly tasks?: readonly TaskView[];
  /** This bot's standing staff, the bots it created. */
  readonly bots?: readonly { botId: string; name: string }[];
  /** A standing bot's work items, which it keeps itself. */
  readonly work?: readonly WorkItem[];
  /** This assistant's own process mode; the device's default, notifications and letters are in Settings > Assistants. */
  readonly process?: ProcessModeChoice;
  /** The mission, for an assistant whose bot details the reader may change. */
  readonly mission?: MissionChoice;
  readonly settings?: ReactNode;
  readonly files?: readonly SessionFile[];
  readonly openFile?: (file: SessionFile, trigger: HTMLElement) => void;
}

/**
 * The details of an assistant (I3 plan, section 4.5), one component for both modes, in the mockup's order: its card, this
 * process mode, where it works, its sessions, model and settings,
 * and its files. A panel beside the conversation or over a window, or a sheet on a phone.
 */
export function AssistantDetails({ assistant, surface, onClose }: { assistant: AssistantRef; surface: 'panel' | 'sheet'; onClose(): void }) {
  const t = useTranslate();
  const id = useId();
  const options = PROCESS_MODES.map(mode => ({ value: mode, label: t(`process.${mode}` as const) }));
  const section = (key: string, title: string, children: ReactNode) => <section className="lab-assistant-section" aria-labelledby={`${id}-${key}`}>
    <h3 id={`${id}-${key}`}>{title}</h3>{children}</section>;
  const body = <div className="lab-assistant-details-body">
    <AssistantCard id={assistant.id} {...(assistant.picture ? { picture: assistant.picture } : {})} name={assistant.name} {...(assistant.label ? { label: assistant.label } : {})}
      {...(assistant.role ? { role: assistant.role } : {})} {...(assistant.mood ? { mood: assistant.mood } : {})} {...(assistant.action ? { action: assistant.action } : {})}
      {...(assistant.actions ? { actions: assistant.actions } : {})} {...(assistant.setPicture ? { setPicture: assistant.setPicture } : {})} {...(assistant.rename ? { rename: assistant.rename } : {})} />
    {assistant.process?.chooseForAssistant ? section('process', t('process.heading'), <div className="lab-assistant-process">
      <div className="lab-process-choice"><span>{t('process.assistant')}</span>
        <SegmentedControl<ProcessMode> label={t('process.assistant')} options={options} value={assistant.process.mode} onChange={assistant.process.chooseForAssistant} /></div>
    </div>) : null}
    {assistant.mission ? section('mission', t('details.mission'), <MissionEditor mission={assistant.mission} />) : null}
    {assistant.work?.length ? section('work', t('details.work'), <WorkList work={assistant.work} />) : null}
    {assistant.where ? section('where', t('details.where'), <WhereItWorks where={assistant.where} />) : null}
    {assistant.sessions ? section('sessions', t('details.sessions'), <SessionsList sessions={assistant.sessions} />) : null}
    {assistant.bots?.length ? section('bots', t('details.bots'), <ul className="lab-assistant-chain lab-assistant-bots">{assistant.bots.map(bot => <li key={bot.botId}><span className="lab-assistant-session-title">{bot.name}</span></li>)}</ul>) : null}
    {assistant.tasks?.length ? section('tasks', t('details.tasks'), <TasksList tasks={assistant.tasks} />) : null}
    {assistant.settings ? section('model', t('details.model'), <div className="lab-assistant-settings">{assistant.settings}</div>) : null}
    {assistant.files ? section('files', t('details.files'), <FilesList files={assistant.files} {...(assistant.openFile ? { onOpen: assistant.openFile } : {})} />) : null}
  </div>;
  return surface === 'sheet' ? <Sheet open title={assistant.name} detent="large" onClose={onClose}>{body}</Sheet> : body;
}
