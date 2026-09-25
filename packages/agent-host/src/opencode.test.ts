import { expect, it } from 'vitest';
import { createOpenCodeHostRegistration } from './opencode.js';

it('registers a shared server without a native owner and preserves work on disconnect', async () => {
  const registration = await createOpenCodeHostRegistration({ serverUrl: 'http://127.0.0.1:1', username: 'local', password: 'private-server-secret' });
  try {
    expect(registration.adapter.descriptor).toMatchObject({ providerId: 'opencode', displayName: 'OpenCode' });
    expect(registration.preservesWorkOnDisconnect).toBe(true);
    expect(registration.nativePermissionControl).toBe(true);
    expect(registration.directory.setSessionHandoffHandler).toBeUndefined();
    expect(JSON.stringify(registration.adapter.descriptor)).not.toContain('private-server-secret');
  } finally { await registration.directory.close(); }
}, 10000);

it('rejects a requested native restriction that an independently owned server cannot enforce', async () => {
  await expect(createOpenCodeHostRegistration({ restrictedNative: true, serverUrl: 'http://127.0.0.1:1' })).rejects.toThrow(/restrict|policy|shared|sandbox/i);
}, 10000);
