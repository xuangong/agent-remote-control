// The tiles of a bot workbench that the Window does not store: folded strips, and a conversation once the person expands one.
import { SessionFamily } from '../../conversation/SessionFamily.js';
import { tileStatus } from '../../features/windows/bot-workbench-status.js';
import { answerTileId, type WorkbenchTile } from '../../features/windows/bot-workbench.js';
import type { PrimarySessionGroupPane } from '../../kernel/SessionDock.js';
import { Button } from '../../ui/Button.js';
import type { useBotWorkbench } from '../useBotWorkbench.js';
import type { AppScope } from '../types.js';
import type { Translate } from '@orchardworks/agent-client';
import type { ReactNode } from 'react';
import '../../features/windows/bot-workbench.css';

export const DERIVED_TILE_WIDTH = 440;
type TileScope = Pick<AppScope, 'activeView' | 'baseUrl' | 'closeView' | 'compactLayout' | 'directory' | 'draftOwnerBinding' | 'markSessionMissing' | 'messageDrafts' | 'presentSessionView' | 'receiveViewSession'
  | 'remoteHosts' | 'replicaFor' | 'selectedHost' | 'succession' | 'supportingRailOpen' | 'transport' | 'viewNavigation' | 'windowMode'>;

/** What a tile's state is called where the assistant list names states. */
export function tileStateWords(tile: WorkbenchTile, t: Translate): string {
  const state = tile.ended ? t('details.subSessionsEnded') : tile.state === 'needs_input' ? t('state.needsYou') : tile.state === 'idle' ? t('details.subSessionsIdle') : t('state.working');
  return tile.mark === 'you' ? `${t('windows.workbench.mine')} · ${state}` : state;
}

export const GROUP_ENDED = 'group:ended', GROUP_ANSWERS = 'group:answers';
const GROUP_WIDTH = 300;

/** A fold of rows the person opens one at a time: the ended sub-sessions, or the answer sessions. */
function groupPane(id: string, title: string, rows: readonly { id: string; title: string; meta: string }[], expanded: boolean, open: (id: string) => void): PrimarySessionGroupPane {
  return { id, title, width: GROUP_WIDTH, collapsed: !expanded, selected: false, permanent: true, fold: { id, name: title, role: String(rows.length) },
    content: <ul className="lab-workbench-group" aria-label={title}>{rows.map(row => <li key={row.id}><button type="button" onClick={() => open(row.id)}><strong>{row.title}</strong><small>{row.meta}</small></button></li>)}</ul> };
}

/** The panes of the derived tiles, each expanded one holding what `content` draws for it, then the Answers and Ended folds. */
export function workbenchPanes(workbench: ReturnType<typeof useBotWorkbench>, content: (tile: WorkbenchTile) => ReactNode, t: Translate): PrimarySessionGroupPane[] {
  const model = workbench.model;
  const pane = (tile: WorkbenchTile): PrimarySessionGroupPane => ({ id: tile.id, title: tile.title, width: DERIVED_TILE_WIDTH, collapsed: tile.folded, selected: workbench.selected === tile.id, permanent: true,
    fold: { id: tile.taskId ?? tile.id, name: tile.title, role: tileStateWords(tile, t), status: tileStatus(tile) }, content: tile.folded ? null : content(tile) });
  const tiles = [...(model?.derived ?? []), ...(model?.answerTiles ?? [])].filter(tile => tile.locator).map(pane);
  const answers = (model?.answers ?? []).filter(row => row.locator && !model?.answerTiles.some(tile => tile.id === answerTileId(row.teamId)));
  const ended = model?.ended ?? [];
  return [...tiles,
    ...answers.length ? [groupPane(GROUP_ANSWERS, t('windows.workbench.answers'), answers.map(row => ({ id: answerTileId(row.teamId), title: row.conversation, meta: t('windows.workbench.answerMeta', { count: row.count }) })), workbench.expandedIds.has(GROUP_ANSWERS), workbench.focus)] : [],
    ...ended.length ? [groupPane(GROUP_ENDED, t('details.subSessionsEnded'), ended.map(tile => ({ id: tile.id, title: tile.title, meta: tile.lastWork ?? '' })), workbench.expandedIds.has(GROUP_ENDED), workbench.focus)] : []];
}

export function derivedWorkbenchPanes(workbench: ReturnType<typeof useBotWorkbench>, scope: TileScope, t: Translate): PrimarySessionGroupPane[] {
  return workbenchPanes(workbench, tile => <DerivedTile tile={tile} target={{ ...tile.locator!, title: tile.title }} scope={scope} t={t} onKeep={() => void workbench.keep(tile)} />, t);
}

/** The bar above a derived tile's conversation: its state, a note when it has ended, and Keep. */
export function DerivedTileBar({ tile, t, onKeep }: { tile: WorkbenchTile; t: Translate; onKeep(): void }) {
  return <div className="lab-derived-tile-bar" data-pane-selection-ignore>
    <span className="lab-derived-tile-state">{tileStateWords(tile, t)}</span>
    {tile.ended ? <span className="lab-derived-tile-note">{t('windows.workbench.endedNote')}</span> : null}
    {tile.id.startsWith('answer:') ? null : <Button title={t('windows.workbench.keepHint')} onClick={onKeep}>{t('windows.workbench.keep')}</Button>}
  </div>;
}

function DerivedTile({ tile, target, scope, t, onKeep }: { tile: WorkbenchTile; target: { hostId: string; providerId: string; nativeSessionId: string; title: string }; scope: TileScope; t: Translate; onKeep(): Promise<void> | void }) {
  const { activeView, baseUrl, closeView, compactLayout, directory, draftOwnerBinding, markSessionMissing, messageDrafts, presentSessionView, receiveViewSession, remoteHosts, replicaFor, selectedHost, succession, supportingRailOpen, transport, viewNavigation, windowMode } = scope;
  const slot = succession.ensureView(target);
  const host = remoteHosts.find(candidate => candidate.id === target.hostId);
  return <div className="lab-derived-tile" data-derived-tile={tile.id} data-state={tile.state}>
    <DerivedTileBar tile={tile} t={t} onKeep={onKeep} />
    <SessionFamily baseUrl={baseUrl} storageScope={baseUrl} target={target} viewId={tile.id} folded={false} onCloseView={closeView}
      sessionIntent={tile.readOnly ? 'history' : undefined}
      successionContext={succession.successionContextFor(slot.id)}
      directoryFor={hostId => hostId === selectedHost.id ? directory : undefined}
      hostLabel={host?.name ?? target.hostId} offline={host?.online === false}
      compact={compactLayout} active={windowMode && activeView === 'workbench' && !supportingRailOpen}
      transport={transport} draftStore={messageDrafts} replicaFor={replicaFor} onSessionBound={receiveViewSession} onSessionUnavailable={markSessionMissing}
      draftBinding={draftOwnerBinding(slot.owners.text)} imageDraftBinding={slot.owners.image}
      displayBinding={{ scope: baseUrl, key: tile.id }}
      // A subagent opens beside a stored tile, so a derived tile is kept first; the person keeps what they open.
      navigation={(source, state, actions) => { const navigation = viewNavigation(source, state, actions); const open = navigation.onOpenChildSession;
        return open ? { ...navigation, onOpenChildSession: async child => { await onKeep(); await open(child); } } : navigation; }}
      sessionPresentation={presentSessionView} />
  </div>;
}
