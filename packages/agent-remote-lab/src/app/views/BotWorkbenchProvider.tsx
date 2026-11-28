// The bot workbench's actions for the places that start, bind and open one, and the choices they ask for.
import { useMemo, useState, type ReactNode } from 'react';
import { BotWorkbenchContext, type BotWorkbenchActions } from '../../features/windows/BotWorkbenchContext.js';
import { BotWorkbenchSheets } from '../../features/windows/BotWorkbenchSheets.js';
import { standingBots } from '../../features/windows/bot-workbench-binding.js';
import { workbenchBotId } from '../../features/windows/bot-workbench.js';
import type { AppScope } from '../types.js';

export function BotWorkbenchProvider({ scope, children }: { readonly scope: Pick<AppScope, 'assistantNames' | 'bindWorkbenchToBot' | 'createFreeWindow' | 'openWorkbench' | 'setWorkbenchSheet' | 'unbindWorkbenchFromBot' | 'windowWorkspace' | 'workbenchSheet'>; readonly children: ReactNode }) {
  const { assistantNames, bindWorkbenchToBot, createFreeWindow, openWorkbench, setWorkbenchSheet, unbindWorkbenchFromBot, windowWorkspace, workbenchSheet } = scope;
  const [busy, setBusy] = useState(false);
  const groups = windowWorkspace.groups;
  const bots = useMemo(() => standingBots(groups).map(bot => ({ botId: bot.botId, name: assistantNames.view(bot.groupId, bot.viewId) })), [groups, assistantNames]);
  const actions = useMemo<BotWorkbenchActions>(() => ({ bots, request: setWorkbenchSheet, openWorkbench,
    boundTo: window => { const botId = workbenchBotId(window); const bot = botId ? bots.find(item => item.botId === botId) : undefined; return botId ? { botId, name: bot?.name ?? botId } : undefined; } }), [bots, setWorkbenchSheet, openWorkbench]);
  const open = windowWorkspace.readWindow();
  const run = async (action: () => void | Promise<void>) => { setBusy(true); try { await action(); } finally { setBusy(false); setWorkbenchSheet(undefined); } };
  return <BotWorkbenchContext.Provider value={actions}>{children}
    {workbenchSheet ? <BotWorkbenchSheets sheet={workbenchSheet} bots={bots} busy={busy} boundName={open ? actions.boundTo(open)?.name : undefined} onClose={() => setWorkbenchSheet(undefined)}
      onFree={() => void run(createFreeWindow)} onOpenBot={botId => void run(() => openWorkbench(botId))} onBind={botId => void run(() => bindWorkbenchToBot(botId))}
      onUnbind={() => void run(unbindWorkbenchFromBot)} /> : null}
  </BotWorkbenchContext.Provider>;
}
