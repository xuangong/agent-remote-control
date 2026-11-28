import { Sheet } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Button } from '../../ui/Button.js';
import './bot-workbench.css';

export type WorkbenchSheet = 'new' | 'bind' | 'unbind';
interface Choice { readonly botId: string; readonly name: string }

/** The choices around bot workbenches: what a new one is, which bot to bind to, and the unbind confirmation. */
export function BotWorkbenchSheets({ sheet, bots, boundName, busy, onClose, onFree, onOpenBot, onBind, onUnbind }: {
  sheet: WorkbenchSheet; bots: readonly Choice[]; boundName?: string; busy: boolean;
  onClose(): void; onFree(): void; onOpenBot(botId: string): void; onBind(botId: string): void; onUnbind(): void;
}) {
  const t = useTranslate();
  const list = (pick: (botId: string) => void) => <ul className="lab-workbench-choices" aria-label={t('windows.workbench.new.bot')}>
    {bots.map(bot => <li key={bot.botId}><Button disabled={busy} onClick={() => pick(bot.botId)}>{bot.name}</Button></li>)}</ul>;
  if (sheet === 'unbind') return <Sheet open title={t('windows.workbench.unbind.title')} detent="content" onClose={onClose}>
    <p className="lab-sheet-message">{t('windows.workbench.unbind.message')}</p>
    <div className="lab-sheet-actions"><Button onClick={onClose}>{t('common.cancel')}</Button><Button disabled={busy} onClick={onUnbind}>{t('windows.workbench.unbind.action')}</Button></div>
  </Sheet>;
  if (sheet === 'bind') return <Sheet open title={t('windows.workbench.bind.title')} detent="content" onClose={onClose}>
    <p className="lab-sheet-message">{t('windows.workbench.bind.message')}</p>
    {bots.length ? list(onBind) : <p className="lab-sheet-message">{t('windows.workbench.new.noBots')}</p>}
  </Sheet>;
  return <Sheet open title={t('windows.workbench.new.title')} detent="content" onClose={onClose}>
    <div className="lab-workbench-kind"><Button disabled={busy} onClick={onFree}>{t('windows.workbench.new.free')}</Button><p>{t('windows.workbench.new.freeHint')}</p></div>
    <div className="lab-workbench-kind"><h3>{t('windows.workbench.new.bot')}</h3><p>{t('windows.workbench.new.botHint')}</p>
      {bots.length ? list(onOpenBot) : <p>{t('windows.workbench.new.noBots')}</p>}</div>
  </Sheet>;
}
