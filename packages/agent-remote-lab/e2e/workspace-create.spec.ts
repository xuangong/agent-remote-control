import { expect, test } from '@playwright/test';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { createAgentHost, type AgentHostDirectory } from '@orchardworks/agent-remote-controller';
import { createRecordedLabProvider } from '../src/server/recorded.js';
import { showNewSession } from './session-navigation';

test('creates a real Host workspace from Browse and starts an Agent inside it', async ({ page, request }, info) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-new-workspace-')));
  const relayUrl = `http://127.0.0.1:${process.env.AGENT_REMOTE_TEST_RELAY_PORT}`;
  const invitation = await (await request.post(`${relayUrl}/v1/remote/pairings`, { data: {} })).json();
  const { provider } = createRecordedLabProvider();
  const sessions = new Map<string, AgentSession>();
  const workspaces = new Map<string, string>();
  const directory: AgentHostDirectory = {
    providerId: 'recorded',
    async list() { return [...workspaces].map(([nativeSessionId, workspace]) => ({ providerId: 'recorded', nativeSessionId,
      title: 'New workspace session', workspace, state: 'idle' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })); },
    async workspaces() { return [{ id: 'root', name: 'Projects', path: root }]; },
    async create(config) {
      const id = `workspace-${sessions.size}`;
      sessions.set(id, await provider.createSession({ ...config, sessionId: id }));
      workspaces.set(id, config.cwd!);
      return id;
    },
    async open(id) { return sessions.get(id)!; },
    async close() { await Promise.all([...sessions.values()].map(session => session.dispose())); },
  };
  const host = createAgentHost({ registrations: [{ adapter: provider, directory }], installationId: `workspace-${info.project.name}`, name: 'Workspace test Host',
    executionPolicy: { defaultWorkspace: root, allowedWorkspaceRoots: [root], lockPermissions: true },
    uplink: { url: relayUrl.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: invitation.key } });
  try {
    const { hostId } = await host.ready;
    await page.goto('/'); await showNewSession(page);
    await page.getByTestId('provider-select').selectOption(JSON.stringify([hostId, 'recorded']));
    await page.getByRole('button', { name: 'Browse…' }).click();
    const modal = page.getByRole('dialog', { name: 'Choose a workspace folder' });
    await expect(modal.getByLabel('Folder path')).toHaveValue(root);
    await modal.getByRole('button', { name: 'New folder', exact: true }).click();
    await modal.getByLabel('New folder name').fill('Fresh project');
    await modal.getByRole('button', { name: 'Create folder', exact: true }).click();
    const path = join(root, 'Fresh project');
    await expect(modal.getByLabel('Folder path')).toHaveValue(path);
    expect((await stat(path)).isDirectory()).toBe(true);
    await modal.getByRole('button', { name: 'Select folder' }).click();
    await expect(page.getByLabel('Working directory', { exact: true })).toHaveValue(path);
    await page.getByTestId('session-create').click();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    expect([...workspaces.values()]).toEqual([path]);
    await page.getByTestId('prompt-input').fill('Hello from the new workspace');
    await page.getByTestId('prompt-input').press('Enter');
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Hello from the new workspace');
    expect(host.state).toBe('registered');
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
