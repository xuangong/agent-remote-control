import { useState } from 'react';

export interface RecordedPlaybackControlsProps {
  onAdvance?: () => void | Promise<void>;
  onRehydrate?: () => void | Promise<void>;
  onStopReader?: () => void | Promise<void>;
}

export function RecordedPlaybackControls({ onAdvance, onRehydrate, onStopReader }: RecordedPlaybackControlsProps) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'info' | 'success' | 'error'; message: string }>({ kind: 'info', message: 'Scenario controls are unavailable for this Provider.' });
  async function run(action: (() => void | Promise<void>) | undefined, success: string): Promise<void> {
    if (!action || pending) return;
    setPending(true);
    try {
      await action();
      setFeedback({ kind: 'success', message: success });
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : 'Lab scenario action failed.' });
    } finally {
      setPending(false);
    }
  }
  return <section className="lab-panel lab-playback-controls" aria-label="Lab scenario controls">
    <p className="lab-eyebrow">Lab scenario controls</p>
    <button type="button" data-testid="playback-advance" disabled={!onAdvance || pending}
      onClick={() => void run(onAdvance, 'Recorded observation advanced.')}>Advance semantic fixture</button>
    <button type="button" data-testid="playback-rehydrate" disabled={!onRehydrate || pending}
      onClick={() => void run(onRehydrate, 'Recorded Timeline rehydrated.')}>Rehydrate Timeline</button>
    <button type="button" data-testid="playback-stop-reader" disabled={!onStopReader || pending}
      onClick={() => void run(onStopReader, 'Provider resource reader stopped.')}>Stop resource reader</button>
    <p className="lab-control-note" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>
  </section>;
}
