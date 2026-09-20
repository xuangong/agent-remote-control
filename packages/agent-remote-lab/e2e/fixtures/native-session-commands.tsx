import { createRoot } from 'react-dom/client';
import { SessionLink } from '../../src/components/SessionLink.js';
import { SessionConnectionNotice, sessionConnectionFailure } from '../../src/components/SessionConnectionNotice.js';
import { DirectoryError } from '../../src/directory-client.js';
import '@agent-remote-controller/agent-remote-web/styles.css';
import '../../src/app.css';

createRoot(document.getElementById('root')!).render(<main style={{ padding: 16 }}>
  <SessionLink session={{ providerId: 'codex', nativeSessionId: '01a0ba06-321d-7600-9141-a1ad0779fc9f', agentId: 'agent', hostId: 'host', title: 'Session' }} />
  <SessionConnectionNotice notice={sessionConnectionFailure(new DirectoryError('file limit', 'native_file_limit', 503), false)} />
</main>);
