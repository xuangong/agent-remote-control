import { useTaskDirectory, useTranslate } from '@orchardworks/agent-client-web/react';
import { BoardList } from '../../conversation/assistant/BoardList.js';
import type { BoardChoice } from '../../conversation/assistant/board-model.js';
import '../../features/windows/bot-workbench.css';

/** The bot's ledger beside its workbench. An item's owner is shown where it is: the owner link brings the tile to the person. */
export function WorkbenchLedger({ botId, canOpenOwner, onOpenOwner }: { botId: string; canOpenOwner(ownerId: string): boolean; onOpenOwner(ownerId: string): void }) {
  const t = useTranslate();
  const directory = useTaskDirectory();
  const board = directory?.boardOf?.(botId);
  if (!directory || !board) return <aside className="lab-workbench-ledger" aria-label={t('windows.workbench.ledger')} data-ledger-loading="" />;
  const choice: BoardChoice = { board, name: id => directory.botName?.(id) ?? id, choices: directory.assignees?.(botId) ?? [],
    staffBoard: id => directory.boardOf?.(id), canOpen: canOpenOwner, open: onOpenOwner,
    ...(directory.writeBoard ? { save: edit => directory.writeBoard!(botId, edit) } : {}) };
  return <aside className="lab-workbench-ledger" aria-label={t('windows.workbench.ledger')}><h2>{t('windows.workbench.ledger')}</h2><BoardList choice={choice} /></aside>;
}
