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
      message: expect.stringContaining('protocolVersion 1.5.0'),
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
      protocolVersion: overrides.protocolVersion ?? '1.5.0',
      borgee: {
        release: 'unreleased', sourceState: 'working_tree',
        baseRevision: '9e21c2ad9a0ba55413960a1681d34675c5d6e026',
        implementation: {
          algorithm: 'sha256', root: '.', scope: ['implementation.txt'],
          digest: 'sha256:d8fdc7cc1b3b4a412e46aaacede0afa478eee509c99e48f2d684e2ede8ee5a15',
        },
      },
      providers: [
        { providerId: 'opencode', native: { name: 'opencode', version: '1.18.18', revision: null },
          sdk: { name: '@opencode-ai/sdk', version: '1.18.31' },
          degradations: ['controls.queue-steer', 'controls.source-references', 'controls.prompt-edit.atomicity', 'events.resources', 'events.usage', 'interactions.native-producers'].map(capability => ({ capability, status: 'degraded', reason: 'Bounded shared native provider.' })),
        },
        {
          providerId: 'dsh',
          native: {
            name: '@deepseek-ai/dsh-agent', version: '0.1.2-rc.1',
            revision: 'a66e4702047846cdaa10c66c9d3df3951f5ea70d',
          },
          degradations: [
            { capability: 'events.session/title', status: 'degraded', reason: 'Not represented in the snapshot.' },
            { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Conditional cancel only; input remains unavailable.' },
            { capability: 'events.compaction.failure', status: 'degraded', reason: 'Failed compaction has no terminal replacement card.' },
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
            { capability: 'sessions.source-reference', status: 'degraded', reason: 'Source references require Codex 0.155.0 or newer.' },
            { capability: 'interactions.form.schema', status: 'degraded', reason: 'Bounded flat schemas only.' },
            { capability: 'interactions.restart-recovery', status: 'degraded', reason: 'Native requests are process-local.' },
            { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Parent summary only.' },
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
        {
          "providerId": "copilot",
          "native": {
            "name": "github-copilot-cli",
            "version": "1.0.83",
            "revision": null
          },
          "sdk": {
            "name": "@github/copilot-sdk",
            "version": "1.0.11"
          },
          "degradations": [
            {
              "capability": "native.experimental-rpc",
              "status": "degraded",
              "reason": "Public SDK model, skills, commands, tasks, metadata, permissions, interruptMainTurn and eventLog APIs are experimental; only CLI 1.0.83 is native-loopback verified. No ACP or private RPC transport."
            },
            {
              "capability": "controls.settings",
              "status": "degraded",
              "reason": "Model catalog is native/auth dependent and changes require idle state. Deferred writes remain unconfirmed until native application. Effort is creation-only; planning and permission-mode controls are unavailable."
            },
            {
              "capability": "events.subagent.navigation",
              "status": "degraded",
              "reason": "Children are task/eventLog views under the loaded parent. Repeated task input and cancellation are supported; approvals/questions stay on parent. No independent child queue, settings, resources, cold root resume or external spawn API."
            },
            {
              "capability": "interactions.callback-identity",
              "status": "degraded",
              "reason": "SDK question callbacks omit native request/agent IDs. Only unique complete-payload event matches bind; identical concurrent unbound questions fail explicitly. Pending callbacks are process-local; no sensitivity/form/plan/grant/external-action mapping."
            },
            {
              "capability": "events.resources-usage",
              "status": "degraded",
              "reason": "Tool output is bounded native text; skill Markdown uses refreshed native locators and bounded regular-file reads. Output images, todos, context capacity, cost and terminal control are not mapped."
            },
            {
              "capability": "controls.immediate-input",
              "status": "degraded",
              "reason": "SDK immediate input may become native queued delivery after the active interaction has ended. Native interactionId/delivery determine public turn grouping; adapter does not synthesize a queue."
            }
          ]
        },
        {
          providerId: 'claude',
          native: { name: 'claude-code', version: '2.1.247', revision: null },
          sdk: { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.247' },
          degradations: [
            { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Nested agents remain parent tool summaries.' },
            { capability: 'events.tool-result.resources', status: 'degraded', reason: 'Binary resources are not exposed.' },
            { capability: 'controls.queue-steer-commands-settings', status: 'degraded', reason: 'No mid-turn input or command menus.' },
            { capability: 'interactions.restart-recovery', status: 'degraded', reason: 'Permission callbacks are process-local.' },
            { capability: 'sessions.empty-persistence', status: 'degraded', reason: 'An empty session may not be persisted.' },
            { capability: 'interactions.form.schema', status: 'degraded', reason: 'Native schema loss prevents form support.' },
          ],
        },
      ],
    }));
    return manifest;
  }
});
