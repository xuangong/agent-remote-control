import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browserLocale, LocaleContext } from '@orchardworks/agent-client-web/react';
import { SessionConfiguration } from '../../src/features/sessions/SessionDirectory.js';
import { SupportingRail } from '../../src/features/windows/SupportingRail.js';
import { SessionDirectoryClient, type CreateSessionOptions } from '../../src/kernel/directory-client.js';
import '../../src/ui/tokens.css';
import '../../src/app.css';
const directory = new SessionDirectoryClient(window.location.origin);
function View() {
  const [value, setValue] = useState<CreateSessionOptions>({ cwd: new URLSearchParams(location.search).get('path') ?? undefined });
  const [open, setOpen] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div style={{ padding: 20, maxWidth: 360 }}>
    <button ref={trigger} onClick={() => setOpen(true)}>New session</button>
    <SupportingRail id="new-session" label="New session" className="" compact open={open} triggerRef={trigger} onClose={() => setOpen(false)}>
      <SessionConfiguration directory={directory} providerId="recorded" value={value} disabled={false} onChange={setValue} />
    </SupportingRail>
    <output style={{ display: 'block', overflowWrap: 'anywhere' }} data-testid="selected-folder">{value.cwd}</output>
  </div>;
}
createRoot(document.getElementById('root')!).render(<LocaleContext.Provider value={browserLocale()}><View /></LocaleContext.Provider>);
