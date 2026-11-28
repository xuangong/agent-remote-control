import { useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { WorkbenchModel, WorkbenchTile } from '../../features/windows/bot-workbench.js';
import { answerTileId } from '../../features/windows/bot-workbench.js';
import { tileStateWords } from './derivedWorkbenchTiles.js';
import '../../features/windows/bot-workbench.css';

interface BotChip { readonly botId: string; readonly name: string }
/**
 * A bot workbench on a phone: the bot's work as a list, the way Chats is one. A row pushes its conversation full screen and the
 * system Back returns here; nothing here is a tile swiped through. Folded groups hold the answers and the ended sub-sessions.
 */
export function WorkbenchOverview({ name, model, chief, staff, onOpenTile, onOpenAnswer, onOpenLedger, onOpenWorkbench, onOpenChat }: {
  name: string; model: WorkbenchModel; chief?: BotChip; staff: readonly BotChip[];
  onOpenTile(id: string): void; onOpenAnswer(id: string): void; onOpenLedger(): void; onOpenWorkbench(botId: string): void; onOpenChat(): void;
}) {
  const t = useTranslate();
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setFolds(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const live = (state: 'needs_input' | 'working' | 'idle') => model.derived.filter(tile => !tile.ended && (state === 'working' ? tile.state === 'working' || tile.state === 'queued' : tile.state === state));
  const rows = (title: string, tiles: readonly WorkbenchTile[]) => tiles.length ? <section key={title} aria-label={title}><h3>{title}</h3>
    <ul>{tiles.map(tile => <li key={tile.id}><button type="button" data-tile={tile.id} data-state={tile.state} onClick={() => onOpenTile(tile.id)}>
      <strong>{tile.title}</strong><small>{[tile.mark ? t('windows.workbench.mine') : '', tile.currentStep ?? tile.lastWork ?? ''].filter(Boolean).join(' · ')}</small></button></li>)}</ul></section> : null;
  const answers = model.answers.filter(row => row.locator);
  return <div className="lab-workbench-overview" data-bot-workbench-overview={model.botId} aria-label={t('windows.workbench.overview', { name })}>
    <header><h2>{name}</h2><button type="button" onClick={onOpenChat}>{t('windows.workbench.openChat')}</button></header>
    {chief || staff.length ? <ul className="lab-workbench-chips" aria-label={t('windows.workbench.staff')}>
      {chief ? <li><button type="button" onClick={() => onOpenWorkbench(chief.botId)}>{t('windows.workbench.chief', { name: chief.name })}</button></li> : null}
      {staff.map(bot => <li key={bot.botId}><button type="button" onClick={() => onOpenWorkbench(bot.botId)}>{bot.name}</button></li>)}</ul> : null}
    {model.main ? rows(t('windows.workbench.main'), [model.main]) : null}
    {rows(t('state.needsYou'), live('needs_input'))}
    {rows(t('state.working'), live('working'))}
    {rows(t('details.subSessionsIdle'), live('idle'))}
    {rows(t('windows.workbench.added'), model.stored)}
    {answers.length ? <section aria-label={t('windows.workbench.answers')}><h3><button type="button" aria-expanded={folds.has('answers')} onClick={() => toggle('answers')}>{t('windows.workbench.answers')} · {answers.length}</button></h3>
      {folds.has('answers') ? <ul>{answers.map(row => <li key={row.teamId}><button type="button" onClick={() => onOpenAnswer(answerTileId(row.teamId))}><strong>{row.conversation}</strong><small>{t('windows.workbench.answerMeta', { count: row.count })}</small></button></li>)}</ul> : null}</section> : null}
    {model.ended.length ? <section aria-label={t('details.subSessionsEnded')}><h3><button type="button" aria-expanded={folds.has('ended')} onClick={() => toggle('ended')}>{t('details.subSessionsEnded')} · {model.ended.length}</button></h3>
      {folds.has('ended') ? <ul>{model.ended.map(tile => <li key={tile.id}><button type="button" data-tile={tile.id} onClick={() => onOpenTile(tile.id)}><strong>{tile.title}</strong><small>{tileStateWords(tile, t)}</small></button></li>)}</ul> : null}</section> : null}
    <section className="lab-workbench-overview-ledger"><button type="button" onClick={onOpenLedger}>{t('windows.workbench.ledger')}</button></section>
  </div>;
}
