import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { ClaudeAgentProvider } from './provider.js';
import { Channel } from './channel.js';

const hostAccess = { environment: { AGENT_REMOTE_SESSION_TOKEN: 'secret-token', AGENT_REMOTE_SESSION_SOCKET: '/private/tmp/sessions.sock' },
  unixSockets: ['/private/tmp/sessions.sock'], skills: '/opt/controller/skills/agent-remote' };
const sockets = { network: { allowUnixSockets: ['/private/tmp/sessions.sock'] } };
const restricted = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };

function fixture() {
  const events = new Channel<any>();
  const sandboxes: unknown[] = [];
  let launched: any;
  const query = { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
    initializationResult: async () => ({ models: [] }), supportedModels: async () => [],
    setModel: async () => {}, setPermissionMode: async () => {},
    applyFlagSettings: async (settings: { sandbox?: unknown }) => { sandboxes.push(settings.sandbox); },
    interrupt: async () => {}, close: () => events.close() };
  return { sandboxes, launched: () => launched, factory: (input: { options: unknown }) => { launched = input.options; return query as any; } };
}

it('gives commands the Host variables, socket and skills on a restricted Host, and never persists them', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', hostAccess }, { restrictedNative: true, query: native.factory });
  try {
    expect(native.launched().env).toMatchObject(hostAccess.environment);
    expect(native.launched().sandbox).toEqual({ ...restricted, ...sockets });
    expect(native.launched().plugins).toEqual([{ type: 'local', path: hostAccess.skills, skipMcpDiscovery: true }]);
    expect(native.launched().settings.permissions.allow).toEqual(['Bash(agent-remote-controller session read:*)', 'Bash(agent-remote-controller session list:*)',
      'Bash(agent-remote-controller session ref list)']);
    expect((await session.runtimeInfo()).persistence?.opaque).not.toContain('secret-token');
  } finally { await session.dispose(); }
});

it('adds the socket to a read-only sandbox without loosening it', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', cwd: '/work', access: 'read_only', hostAccess }, { query: native.factory });
  try {
    expect(native.launched().sandbox).toEqual({ ...restricted, autoAllowBashIfSandboxed: true, filesystem: { denyWrite: ['/work'] }, ...sockets });
  } finally { await session.dispose(); }
});

it('allows the socket without enabling a sandbox the user did not choose, and keeps it allowed across YOLO', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', hostAccess }, { query: native.factory });
  try {
    expect(native.launched().sandbox).toEqual(sockets);
    await session.setSessionSetting!('permissions', 'bypassPermissions');
    await session.setSessionSetting!('permissions', 'default');
    expect(native.sandboxes).toEqual([{ enabled: false, ...sockets }, sockets]);
  } finally { await session.dispose(); }
});

it('asks before session commands in a session without Host access', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
  try { expect(native.launched().settings).toBeUndefined(); } finally { await session.dispose(); }
});

it('passes Host access from resume options and declares support', async () => {
  const native = fixture();
  const cwd = tmpdir();
  const catalog = { info: async () => ({ cwd }), messages: async () => [] } as any;
  const provider = new ClaudeAgentProvider({ query: native.factory, catalog } as any);
  expect(provider.descriptor.sessionHostAccess).toBe(true);
  const session = await provider.resumeSession({ providerId: 'claude', sessionId: '00000000-0000-4000-8000-000000000001', opaque: JSON.stringify({ cwd }) }, {}, { hostAccess });
  try {
    expect(native.launched().env).toMatchObject(hostAccess.environment);
    expect(native.launched().sandbox).toEqual(sockets);
  } finally { await session.dispose(); }
});
