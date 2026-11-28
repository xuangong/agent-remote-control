// A bot workbench around its rail: the header above, the ledger beside. A free workbench is the rail alone.
import { useContext, type ReactNode } from 'react';
import { useTaskDirectory } from '@orchardworks/agent-client-web/react';
import { BotWorkbenchContext } from '../../features/windows/BotWorkbenchContext.js';
import { ownerTarget } from '../../features/windows/bot-workbench-teams.js';
import type { useBotWorkbench } from '../useBotWorkbench.js';
import { WorkbenchHeader } from './WorkbenchHeader.js';
import { WorkbenchLedger } from './WorkbenchLedger.js';

export function BotWorkbenchBody({ workbench, children }: { workbench: ReturnType<typeof useBotWorkbench>; children: ReactNode }) {
  const actions = useContext(BotWorkbenchContext);
  const directory = useTaskDirectory();
  const model = workbench.model;
  if (!model?.botId || !actions) return <>{children}</>;
  const botId = model.botId;
  const name = actions.bots.find(bot => bot.botId === botId)?.name ?? botId;
  const target = (ownerId: string) => ownerTarget(workbench.teams, model, ownerId);
  const needsYou = model.derived.find(tile => tile.state === 'needs_input');
  return <div className="lab-workbench-body" data-bot-workbench={botId}>
    <WorkbenchHeader name={name} needsYou={model.attention.needsYou} working={model.attention.working}
      {...(directory?.chief?.(botId).current ? { chief: directory.chief(botId).current! } : {})} staff={directory?.staff?.(botId) ?? []} ledgerOpen={workbench.ledgerOpen}
      onOpenWorkbench={id => void actions.openWorkbench(id)} onOpenChat={() => void actions.openChat(botId)}
      onFocusNeedsYou={() => { if (needsYou) workbench.focus(needsYou.id); }} onToggleLedger={() => workbench.setLedgerOpen(!workbench.ledgerOpen)} />
    <div className="lab-workbench-main">
      {children}
      {workbench.ledgerOpen ? <WorkbenchLedger botId={botId} canOpenOwner={id => !!target(id)}
        onOpenOwner={id => { const found = target(id); if (found?.kind === 'tile') workbench.focus(found.id); else if (found) void actions.openWorkbench(found.botId); }} /> : null}
    </div>
  </div>;
}
