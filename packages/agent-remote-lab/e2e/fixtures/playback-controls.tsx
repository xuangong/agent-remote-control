import { createRoot } from 'react-dom/client';
import { RecordedPlaybackControls } from '../../src/features/diagnostics/RecordedPlaybackControls.js';
import '../../src/session-view-styles';
import '../../src/app.css';

// The Lab scenario controls of Settings > Advanced, in a page as wide as the layout under test.
createRoot(document.getElementById('root')!).render(<div className="lab-shell" style={{ display: 'block' }}><main className="lab-page">
  <RecordedPlaybackControls onAdvance={async () => {}} onRehydrate={async () => {}} onStopReader={async () => {}} />
</main></div>);
