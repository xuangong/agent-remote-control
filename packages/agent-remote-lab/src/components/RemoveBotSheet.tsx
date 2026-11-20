import { useTranslate } from '@orchardworks/agent-client-web/react';
import { closingWith, removalMessage } from '../bot-removal.js';
import type { WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { Sheet } from '@orchardworks/agent-client-web/primitives';
import { Button } from '../ui/Button.js';
import { useAssistantNames } from './assistant/names-context.js';

/**
 * Confirms removing a bot from its group, naming what closes with it. Inside the group's Window it is “this group”;
 * Bot mode names the group.
 */
export function RemoveBotSheet({ name, groupTitle, window, viewId, busy = false, onCancel, onRemove }: {
  name: string; groupTitle?: string; window: WorkspaceWindow | undefined; viewId: string; busy?: boolean;
  onCancel(): void; onRemove(): void;
}) {
  const t = useTranslate();
  const names = useAssistantNames();
  return <Sheet open title={groupTitle ? t('navigation.removeBot.titleInGroup', { name, group: groupTitle }) : t('navigation.removeBot.titleInThisGroup', { name })} detent="content" onClose={() => { if (!busy) onCancel(); }}>
    <p className="lab-sheet-message">{removalMessage(closingWith(window, viewId, id => window ? names.view(window.id, id) : id))}</p>
    <div className="lab-sheet-actions">
      <Button disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
      <Button variant="destructive" disabled={busy} aria-busy={busy || undefined} onClick={onRemove}>{t('common.remove')}</Button>
    </div>
  </Sheet>;
}
