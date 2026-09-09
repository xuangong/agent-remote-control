import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCompatibilityManifest } from './compatibility.js';

const manifestEnvironment = 'BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST';
const implementationDigest = 'sha256:d8fdc7cc1b3b4a412e46aaacede0afa478eee509c99e48f2d684e2ede8ee5a15';

describe('Agent Remote compatibility manifest', () => {
  const roots: string[] = [];
  const originalManifest = process.env[manifestEnvironment];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
    if (originalManifest === undefined) delete process.env[manifestEnvironment];
    else process.env[manifestEnvironment] = originalManifest;
  });

  it('loads a verifiable working-tree identity and the complete Provider matrix', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest());

    expect(loadCompatibilityManifest()).toMatchObject({
      borgee: {
        sourceState: 'working_tree',
        baseRevision: '9e21c2ad9a0ba55413960a1681d34675c5d6e026',
        implementation: { digest: implementationDigest },
      },
      providers: [
        { providerId: 'dsh' },
        { providerId: 'codex' },
      ],
    });
  });

  it('rejects a working-tree identity whose scoped bytes do not match its digest', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({
      implementationDigest: `sha256:${'0'.repeat(64)}`,
    }));

    expect(() => loadCompatibilityManifest()).toThrow('implementation digest');
  });

  it('accepts scope ordering independent of the process locale', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({
      implementationDigest: 'sha256:52fcdef99d2c61dc5fdc85b504f7832aed8656112d44beea69297a217ea74692',
      implementationScope: ['Z.txt', 'a.txt'],
    }), { 'Z.txt': 'upper\n', 'a.txt': 'lower\n' });

    expect(() => loadCompatibilityManifest()).not.toThrow();
  });

  it('requires exactly the DSH and Codex Provider entries', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ omitCodex: true }));

    expect(() => loadCompatibilityManifest()).toThrow('exact Provider set');
  });

  it('requires the unsupported capabilities evidenced for each Provider', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ emptyCodexDegradations: true }));

    expect(() => loadCompatibilityManifest()).toThrow('Codex degradation');
  });

  it('requires the title capability gap evidenced for DSH', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ omitDshTitle: true }));

    expect(() => loadCompatibilityManifest()).toThrow('DSH degradation');
  });

  it('requires the evidenced unknown message source degradation', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ omitDshUnknownSource: true }));

    expect(() => loadCompatibilityManifest()).toThrow('DSH degradation');
  });

  it('requires the evidenced status for each degradation', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ codexFormStatus: 'unsupported' }));

    expect(() => loadCompatibilityManifest()).toThrow('Codex degradation');
  });

  it.each([
    ['thread name metadata', { omitCodexThreadName: true }],
    ['command terminal interaction', { omitCodexTerminalInteraction: true }],
  ] as const)('requires the evidenced Codex %s degradation', (_name, overrides) => {
    process.env[manifestEnvironment] = writeManifest(validManifest(overrides));

    expect(() => loadCompatibilityManifest()).toThrow('Codex degradation');
  });

  it('rejects duplicate degradation capabilities', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ duplicateDshTitle: true }));

    expect(() => loadCompatibilityManifest()).toThrow('unique degradation');
  });

  it('rejects undeclared degradation capabilities', () => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ extraCodexDegradation: true }));

    expect(() => loadCompatibilityManifest()).toThrow('Codex degradation');
  });

  function writeManifest(manifest: object, files: Record<string, string> = { 'implementation.txt': 'implementation\n' }): string {
    const root = mkdtempSync(join(tmpdir(), 'borgee-compatibility-'));
    roots.push(root);
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
    const path = join(root, 'compatibility.json');
    writeFileSync(path, JSON.stringify(manifest));
    return path;
  }
});

function validManifest(overrides: {
  implementationDigest?: string;
  implementationScope?: string[];
  omitCodex?: boolean;
  emptyCodexDegradations?: boolean;
  omitDshTitle?: boolean;
  omitDshUnknownSource?: boolean;
  omitCodexThreadName?: boolean;
  omitCodexTerminalInteraction?: boolean;
  codexFormStatus?: 'unsupported' | 'degraded';
  duplicateDshTitle?: boolean;
  extraCodexDegradation?: boolean;
} = {}): object {
  const dshDegradations = [
    ...(!overrides.omitDshTitle ? [{
      capability: 'events.session/title', status: 'degraded',
      reason: 'The adapter recognizes the title but the Agent Snapshot has no title field.',
    }] : []),
    ...(!overrides.omitDshUnknownSource ? [{
      capability: 'events.user-message.unknown-source', status: 'degraded',
      reason: 'Unknown injected sources remain visible as diagnostics instead of impersonating the user.',
    }] : []),
    ...(overrides.duplicateDshTitle ? [{
      capability: 'events.session/title', status: 'degraded', reason: 'Duplicate declaration.',
    }] : []),
  ];
  const codexDegradations = overrides.emptyCodexDegradations ? [] : [
    { capability: 'interactions.form.schema', status: overrides.codexFormStatus ?? 'degraded', reason: 'Bounded flat schemas only.' },
    { capability: 'interactions.restart-recovery', status: 'degraded', reason: 'Native requests are process-local.' },
    { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Parent summary only.' },
    ...(!overrides.omitCodexThreadName ? [{
      capability: 'events.thread/name', status: 'degraded',
      reason: 'Thread names remain native session metadata because the Agent Snapshot has no title field.',
    }] : []),
    ...(!overrides.omitCodexTerminalInteraction ? [{
      capability: 'events.commandExecution/terminalInteraction', status: 'degraded',
      reason: 'Terminal interactions remain native command side-channel activity because tool detail has no process progress fields.',
    }] : []),
    ...(overrides.extraCodexDegradation ? [{
      capability: 'events.unknown', status: 'degraded', reason: 'Undeclared degradation.',
    }] : []),
  ];
  const providers = [
    {
      providerId: 'dsh',
      native: {
        name: '@deepseek-ai/dsh-agent', version: '0.1.2-rc.1',
        revision: 'a66e4702047846cdaa10c66c9d3df3951f5ea70d',
      },
      degradations: dshDegradations,
    },
    ...(overrides.omitCodex ? [] : [{
      providerId: 'codex',
      native: { name: 'codex-cli', version: '0.148.0', revision: null },
      degradations: codexDegradations,
    }]),
  ];
  return {
    schemaVersion: 1,
    protocolVersion: '1.3.0',
    borgee: {
      release: 'unreleased',
      sourceState: 'working_tree',
      baseRevision: '9e21c2ad9a0ba55413960a1681d34675c5d6e026',
      implementation: {
        algorithm: 'sha256',
        root: '.',
        scope: overrides.implementationScope ?? ['implementation.txt'],
        digest: overrides.implementationDigest ?? implementationDigest,
      },
    },
    providers,
  };
}
