import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeHostRegistration } from './claude.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function executable(version: string, expectedHome?: string) {
  const root = await mkdtemp(join(tmpdir(), 'claude-host-version-')); roots.push(root);
  const path = join(root, 'claude');
  await writeFile(path, `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(2);\nif (${JSON.stringify(expectedHome)} && process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(expectedHome)}) process.exit(3);\nconsole.log(${JSON.stringify(version)});\n`);
  await chmod(path, 0o700); return path;
}

describe('Claude Host registration', () => {
  it.each(['2.1.246 (Claude Code)', '2.0.999 (Claude Code)', '1.99.999 (Claude Code)', 'unrecognized'])('rejects unsupported native version %s', async (version) => {
    await expect(createClaudeHostRegistration({ executable: await executable(version) })).rejects.toThrow(/2\.1\.247 or newer/);
  });

  it('reports an unavailable explicitly selected executable', async () => {
    await expect(createClaudeHostRegistration({ executable: '/missing-agent-host-claude' })).rejects.toThrow();
  });

  it('enables native permission settings with the restricted Host policy', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'claude-permissions-profile-')); roots.push(profile);
    const registration = await createClaudeHostRegistration({ executable: await executable('2.1.247 (Claude Code)', profile),
      claudeHome: profile, restrictedNative: true });
    try { expect(registration.nativePermissionControl).toBe(true); }
    finally { await registration.directory.close(); }
  });

  it('accepts the supported executable and applies an isolated native configuration root', async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const profile = await mkdtemp(join(tmpdir(), 'claude-isolated-profile-')); roots.push(profile);
    const registration = await createClaudeHostRegistration({ executable: await executable('2.1.247 (Claude Code)', profile),
      claudeHome: profile, workspaces: [{ id: 'work', name: 'Work', path: '/work' }] });
    expect(registration.adapter.descriptor).toMatchObject({ providerId: 'claude', displayName: 'Claude Code' });
    expect(registration.directory.providerId).toBe('claude');
    expect(await registration.directory.workspaces()).toEqual([{ id: 'work', name: 'Work', path: '/work' }]);
    await expect(registration.directory.openChild!('unloaded-parent', 'child')).rejects.toThrow('parent session is not loaded');
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(previous);
    await registration.directory.close();
  });
});
