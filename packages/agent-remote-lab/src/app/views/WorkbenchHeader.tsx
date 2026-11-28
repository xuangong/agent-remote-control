import { useTranslate } from '@orchardworks/agent-client-web/react';
import '../../features/windows/bot-workbench.css';

interface BotChip { readonly botId: string; readonly name: string }
/** The bot workbench's header: whose it is, what needs the person, its chief and staff for switching, and the ledger. */
export function WorkbenchHeader({ name, needsYou, working, chief, staff, ledgerOpen, onOpenWorkbench, onOpenChat, onFocusNeedsYou, onToggleLedger }: {
  name: string; needsYou: number; working: number; chief?: BotChip; staff: readonly BotChip[]; ledgerOpen: boolean;
  onOpenWorkbench(botId: string): void; onOpenChat(): void; onFocusNeedsYou(): void; onToggleLedger(): void;
}) {
  const t = useTranslate();
  return <header className="lab-workbench-header" aria-label={t('windows.workbench.header', { name })}>
    <h2 className="lab-workbench-header-name">{name}</h2>
    {needsYou ? <button type="button" data-attention="" onClick={onFocusNeedsYou}>{t('windows.workbench.needsYou', { count: needsYou })}</button> : null}
    {working ? <span>{t('windows.workbench.working', { count: working })}</span> : null}
    {chief || staff.length ? <ul className="lab-workbench-chips" aria-label={t('windows.workbench.staff')}>
      {chief ? <li><button type="button" title={t('windows.workbench.openStaff', { name: chief.name })} onClick={() => onOpenWorkbench(chief.botId)}>{t('windows.workbench.chief', { name: chief.name })}</button></li> : null}
      {staff.map(bot => <li key={bot.botId}><button type="button" title={t('windows.workbench.openStaff', { name: bot.name })} onClick={() => onOpenWorkbench(bot.botId)}>{bot.name}</button></li>)}
    </ul> : null}
    <div className="lab-workbench-header-actions">
      <button type="button" onClick={onOpenChat}>{t('windows.workbench.openChat')}</button>
      <button type="button" aria-pressed={ledgerOpen} onClick={onToggleLedger}>{t('windows.workbench.ledger')}</button>
    </div>
  </header>;
}
