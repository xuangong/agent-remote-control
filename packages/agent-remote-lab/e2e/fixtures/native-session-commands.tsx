import { createRoot } from 'react-dom/client';
import { translator } from '@orchardworks/agent-client';
import { browserLocale, LocaleContext } from '@orchardworks/agent-client-web/react';
import { SessionLink, SessionWorkspaceContext } from '../../src/kernel/SessionLink.js';
import { SessionConnectionNotice, sessionConnectionFailure } from '../../src/kernel/SessionConnectionNotice.js';
import { DirectoryError } from '../../src/kernel/directory-client.js';
import '../../src/ui/tokens.css';
import '@orchardworks/agent-client-web/styles.css';
import '../../src/app.css';

const locale = browserLocale();
createRoot(document.getElementById('root')!).render(<LocaleContext.Provider value={locale}><main style={{ padding: 16 }}>
  <SessionWorkspaceContext.Provider value={{ providerId: 'codex', nativeSessionId: '01a0ba06-321d-7600-9141-a1ad0779fc9f', cwd: '/Users/developer/Projects/agent-remote-control/packages/agent-remote-lab' }}>
    <SessionLink session={{ providerId: 'codex', nativeSessionId: '01a0ba06-321d-7600-9141-a1ad0779fc9f', agentId: 'agent', hostId: 'host', title: 'Session' }} />
  </SessionWorkspaceContext.Provider>
  <SessionConnectionNotice notice={sessionConnectionFailure(new DirectoryError('file limit', 'native_file_limit', 503), false, translator(locale))} />
</main></LocaleContext.Provider>);
