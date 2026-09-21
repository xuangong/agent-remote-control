import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import { LiveControlPanel, type LiveControlPanelProps } from './LiveControlPanel.js';

export function DraftComposer({ binding, ...props }: LiveControlPanelProps & { binding?: DraftBinding }) {
  const draft = useBoundDraft(binding);
  return <LiveControlPanel {...props} draft={binding ? draft.text : props.draft} onDraftChange={binding ? draft.set : props.onDraftChange} />;
}
