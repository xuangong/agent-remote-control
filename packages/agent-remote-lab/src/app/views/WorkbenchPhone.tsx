// A bot workbench on a phone: its list of work, and the conversation a row pushes. The Window's tile stack is not used here.
import { useContext } from 'react';
import { useTaskDirectory } from '@orchardworks/agent-client-web/react';
import { BotWorkbenchContext } from '../../features/windows/BotWorkbenchContext.js';
import { ownerTarget } from '../../features/windows/bot-workbench-teams.js';
import { SessionDockRail, type PrimarySessionGroupPane } from '../../kernel/SessionDock.js';
import type { useBotWorkbench } from '../useBotWorkbench.js';
import { WorkbenchLedger } from './WorkbenchLedger.js';
import { WorkbenchOverview } from './WorkbenchOverview.js';

export function WorkbenchPhone({ workbench, panes, openStored }: { workbench: ReturnType<typeof useBotWorkbench>; panes: readonly PrimarySessionGroupPane[]; openStored(id: string): void }) {
  const actions = useContext(BotWorkbenchContext);
  const directory = useTaskDirectory();
  const model = workbench.model;
  if (!model?.botId || !actions) return null;
  const botId = model.botId;
  const name = actions.bots.find(bot => bot.botId === botId)?.name ?? botId;
  const target = (ownerId: string) => ownerTarget(workbench.teams, model, ownerId);
  const openTile = (id: string) => {
    if (model.stored.some(tile => tile.id === id) || model.main?.id === id) { workbench.clearSelection(); openStored(id); } else workbench.focus(id);
    workbench.openScreen(id);
  };
  const screen = workbench.screen;
  const pushed = screen !== 'home';
  const shown = panes.filter(pane => pane.id === screen).map(pane => ({ ...pane, collapsed: false, selected: true }));
  return <div className="lab-workbench-phone" data-pushed={pushed || undefined} data-workbench-screen={screen}>
    {!pushed ? <WorkbenchOverview name={name} model={model} {...(directory?.chief?.(botId).current ? { chief: directory.chief(botId).current! } : {})} staff={directory?.staff?.(botId) ?? []}
      onOpenTile={openTile} onOpenAnswer={openTile} onOpenLedger={() => workbench.openScreen('ledger')}
      onOpenWorkbench={id => void actions.openWorkbench(id)} onOpenChat={() => void actions.openChat(botId)} />
    : <>
      <button type="button" className="lab-workbench-back" onClick={workbench.back}>‹ {name}</button>
      {screen === 'ledger' ? <WorkbenchLedger botId={botId} canOpenOwner={id => !!target(id)}
        onOpenOwner={id => { const found = target(id); if (found?.kind === 'tile') openTile(found.id); else if (found) void actions.openWorkbench(found.botId); }} />
        : <SessionDockRail compact primaryGroups={shown} onSelectPrimaryGroup={() => {}} />}
    </>}
  </div>;
}
