import { closingWith, removalMessage } from '../bot-removal.js';
import type { WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { Sheet } from '../ui/Sheet.js';
import { Button } from '../ui/Button.js';

/**
 * Confirms removing a bot from its group, naming what closes with it. Inside the group's Window it is “this group”;
 * Bot mode names the group.
 */
export function RemoveBotSheet({ name, groupTitle, window, viewId, busy = false, onCancel, onRemove }: {
  name: string; groupTitle?: string; window: WorkspaceWindow | undefined; viewId: string; busy?: boolean;
  onCancel(): void; onRemove(): void;
}) {
  return <Sheet open title={`Remove “${name}” from ${groupTitle ? `“${groupTitle}”` : 'this group'}?`} detent="content" onClose={() => { if (!busy) onCancel(); }}>
    <p className="lab-sheet-message">{removalMessage(closingWith(window, viewId))}</p>
    <div className="lab-sheet-actions">
      <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button variant="destructive" disabled={busy} aria-busy={busy || undefined} onClick={onRemove}>Remove</Button>
    </div>
  </Sheet>;
}
