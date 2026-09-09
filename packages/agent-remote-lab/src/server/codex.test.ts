import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCodexValidationServer } from './codex.js';

describe('Codex Lab composition', () => {
  const roots: string[] = [];
  const originalManifest = process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST;
  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
    if (originalManifest === undefined) delete process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST;
    else process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST = originalManifest;
  });

  it('rejects an executable that is not the pinned real app-server version', async () => {
    const executable = fakeExecutable('codex-cli 0.149.0');
    await expect(createCodexValidationServer({ executable })).rejects.toThrow('codex-cli 0.148.0');
  });

  it('compares the normalized Codex version exactly', async () => {
    const executable = fakeExecutable('codex-cli 0.148.0 nightly');
    const attempt = await createCodexValidationServer({ executable }).then(
      (server) => ({ server }),
      (error: unknown) => ({ error }),
    );
    if ('server' in attempt) await attempt.server.close();
    expect(attempt).toMatchObject({ error: expect.objectContaining({
      message: expect.stringContaining('got codex-cli 0.148.0 nightly'),
    }) });
  });

  it('takes the expected Codex version from the selected compatibility manifest', async () => {
    process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST = compatibilityManifest({
      codexVersion: '0.149.0',
    });
    const attempt = await createCodexValidationServer({ executable: fakeExecutable('codex-cli 0.148.0') }).then(
      (server) => ({ server }),
      (error: unknown) => ({ error }),
    );
    if ('server' in attempt) await attempt.server.close();
    expect(attempt).toMatchObject({ error: expect.objectContaining({
      message: expect.stringContaining('codex-cli 0.149.0'),
    }) });
  });

  it('rejects a manifest for a different Agent Remote protocol version', async () => {
    process.env.BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST = compatibilityManifest({
      protocolVersion: '2.0.0',
    });
    const attempt = await createCodexValidationServer({ executable: fakeExecutable('codex-cli 0.148.0') }).then(
      (server) => ({ server }),
      (error: unknown) => ({ error }),
    );
    if ('server' in attempt) await attempt.server.close();
    expect(attempt).toMatchObject({ error: expect.objectContaining({
      message: expect.stringContaining('protocolVersion 1.2.0'),
    }) });
  });

  it('registers Codex through the same Provider registry for an explicit absolute executable', async () => {
    const executable = fakeExecutable('codex-cli 0.148.0');
    const composition = await createCodexValidationServer({ executable });
    try {
      expect(composition.relay.listProviders()).toEqual([{ providerId: 'codex', displayName: 'Codex (fixture)' }]);
    } finally {
      await composition.close();
    }
  });

  function fakeExecutable(version: string): string {
    const root = mkdtempSync(join(tmpdir(), 'borgee-codex-executable-'));
    roots.push(root);
    const executable = join(root, 'codex');
    writeFileSync(executable, `#!/usr/bin/env bash\nprintf '%s\\n' '${version}'\n`);
    chmodSync(executable, 0o755);
    return executable;
  }

  function compatibilityManifest(overrides: { codexVersion?: string; protocolVersion?: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'borgee-compatibility-manifest-'));
    roots.push(root);
    writeFileSync(join(root, 'implementation.txt'), 'implementation\n');
    const manifest = join(root, 'compatibility.json');
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      protocolVersion: overrides.protocolVersion ?? '1.2.0',
      borgee: {
        release: 'unreleased', sourceState: 'working_tree',
        baseRevision: '9e21c2ad9a0ba55413960a1681d34675c5d6e026',
        implementation: {
          algorithm: 'sha256', root: '.', scope: ['implementation.txt'],
          digest: 'sha256:d8fdc7cc1b3b4a412e46aaacede0afa478eee509c99e48f2d684e2ede8ee5a15',
        },
      },
      providers: [
        {
          providerId: 'dsh',
          native: {
            name: '@deepseek-ai/dsh-agent', version: '0.1.2-rc.1',
            revision: 'a66e4702047846cdaa10c66c9d3df3951f5ea70d',
          },
          degradations: [
            { capability: 'events.session/title', status: 'degraded', reason: 'Not represented in the snapshot.' },
            {
              capability: 'events.user-message.unknown-source', status: 'degraded',
              reason: 'Unknown sources are diagnostic.',
            },
          ],
        },
        {
          providerId: 'codex',
          native: { name: 'codex-cli', version: overrides.codexVersion ?? '0.148.0', revision: null },
          degradations: [
            { capability: 'readResource', status: 'unsupported', reason: 'Not exposed by the adapter.' },
            {
              capability: 'events.thread/name', status: 'degraded',
              reason: 'Thread names are not represented in the Agent Snapshot.',
            },
            {
              capability: 'events.commandExecution/terminalInteraction', status: 'degraded',
              reason: 'Terminal interactions are not represented in normalized tool detail.',
            },
          ],
        },
      ],
    }));
    return manifest;
  }
});
