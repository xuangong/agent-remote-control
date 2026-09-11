import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCompatibilityManifest } from './compatibility.js';

const manifestEnvironment = 'BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST';
const implementationDigest = 'sha256:d8fdc7cc1b3b4a412e46aaacede0afa478eee509c99e48f2d684e2ede8ee5a15';

const copilotCapabilities = ['native.experimental-rpc', 'controls.settings', 'events.subagent.navigation', 'interactions.callback-identity', 'events.resources-usage', 'controls.immediate-input'];

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
        { providerId: 'claude', native: { name: 'claude-code', version: '2.1.247', revision: null },
          sdk: { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.247' } },
        { providerId: 'copilot', native: {name: 'github-copilot-cli', version: '1.0.83', revision: null}, sdk: {name: '@github/copilot-sdk', version: '1.0.11'} },
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

  it('requires exactly the Claude, Codex, Copilot, and DSH Provider entries', () => {
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

  it.each(['missing', 'unknown', 'duplicate'] as const)('rejects a %s Provider in the complete matrix', (kind) => {
    const manifest = validManifest();
    if (kind === 'missing') manifest.providers = manifest.providers.filter(({ providerId }) => providerId !== 'claude');
    else if (kind === 'unknown') manifest.providers.push({ ...manifest.providers[0]!, providerId: 'unknown' });
    else manifest.providers.push(manifest.providers[0]!);
    process.env[manifestEnvironment] = writeManifest(manifest);
    expect(() => loadCompatibilityManifest()).toThrow(kind === 'duplicate' ? 'unique Provider' : 'exact Provider set');
  });

  it.each([
    { claudeName: 'another-cli' }, { claudeVersion: '2.1.246' }, { claudeVersion: '2.1.248' },
    { claudeRevision: 'unexpected-revision' }, { claudeSdkName: 'another-sdk' }, { claudeSdkVersion: '0.3.248' }, { omitClaudeSdk: true },
  ])('rejects incompatible Claude native or SDK pins: %j', (overrides) => {
    process.env[manifestEnvironment] = writeManifest(validManifest(overrides));
    expect(() => loadCompatibilityManifest()).toThrow('Claude');
  });

  it.each([
    'events.subagent.navigation', 'events.tool-result.resources', 'controls.queue-steer-commands-settings',
    'interactions.restart-recovery', 'sessions.empty-persistence', 'interactions.form.schema',
  ])('requires the evidenced Claude %s degradation', (capability) => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ omitClaudeDegradation: capability }));
    expect(() => loadCompatibilityManifest()).toThrow('Claude degradation');
  });

  it.each(['duplicate', 'extra', 'wrong-status', 'malformed'] as const)('rejects %s Claude degradation declarations', (kind) => {
    process.env[manifestEnvironment] = writeManifest(validManifest({ invalidClaudeDegradation: kind }));
    expect(() => loadCompatibilityManifest()).toThrow(/degradation/);
  });

  it.each(['missing', 'native-name', 'native-version', 'newer-native', 'native-revision', 'sdk-name', 'sdk-version', 'missing-sdk'] as const)('rejects incompatible Copilot identity: %s', kind => {
    const manifest = validManifest();
    const copilot = manifest.providers.find(p => p.providerId === 'copilot')!;
    if (kind === 'missing') manifest.providers = manifest.providers.filter(p => p !== copilot);
    if (kind === 'native-name') copilot.native.name = 'another-cli';
    if (kind === 'native-version') copilot.native.version = '1.0.82';
    if (kind === 'newer-native') copilot.native.version = '1.0.84';
    if (kind === 'native-revision') copilot.native.revision = 'unexpected';
    if (kind === 'sdk-name') copilot.sdk!.name = 'another-sdk';
    if (kind === 'sdk-version') copilot.sdk!.version = '1.0.12';
    if (kind === 'missing-sdk') delete copilot.sdk;
    process.env[manifestEnvironment] = writeManifest(manifest);
    expect(() => loadCompatibilityManifest()).toThrow(kind === 'missing' ? 'exact Provider set' : 'Copilot');
  });

  it.each(copilotCapabilities)('requires the evidenced Copilot %s degradation', capability => {
    const manifest = validManifest();
    const copilot = manifest.providers.find(p => p.providerId === 'copilot')!;
    copilot.degradations = copilot.degradations.filter(d => d.capability !== capability);
    process.env[manifestEnvironment] = writeManifest(manifest);
    expect(() => loadCompatibilityManifest()).toThrow('Copilot degradation');
  });

  it.each(['duplicate', 'extra', 'wrong-status', 'malformed'] as const)('rejects %s Copilot degradation declarations', kind => {
    const manifest = validManifest();
    const entries = manifest.providers.find(p => p.providerId === 'copilot')!.degradations;
    if (kind === 'duplicate') entries.push({...entries[0]!});
    if (kind === 'extra') entries.push({capability: 'unknown', status: 'degraded', reason: 'Unknown'});
    if (kind === 'wrong-status') entries[0]!.status = 'unsupported';
    if (kind === 'malformed') entries[0]!.reason = '';
    process.env[manifestEnvironment] = writeManifest(manifest);
    expect(() => loadCompatibilityManifest()).toThrow(/degradation/);
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
  claudeName?: string;
  claudeVersion?: string;
  claudeRevision?: string;
  claudeSdkName?: string;
  claudeSdkVersion?: string;
  omitClaudeSdk?: boolean;
  omitClaudeDegradation?: string;
  invalidClaudeDegradation?: 'duplicate' | 'extra' | 'wrong-status' | 'malformed';
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
} = {}) {
  const dshDegradations = [
    { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Conditional cancel only; input remains unavailable.' },
    { capability: 'events.compaction.failure', status: 'degraded', reason: 'Failed compaction has no terminal replacement card.' },
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
  const claudeDegradations = [
    { capability: 'events.subagent.navigation', status: 'degraded', reason: 'Nested agents remain parent tool summaries.' },
    { capability: 'events.tool-result.resources', status: 'degraded', reason: 'Binary resources are not exposed.' },
    { capability: 'controls.queue-steer-commands-settings', status: 'degraded', reason: 'No mid-turn input or command menus.' },
    { capability: 'interactions.restart-recovery', status: 'degraded', reason: 'Permission callbacks are process-local.' },
    { capability: 'sessions.empty-persistence', status: 'degraded', reason: 'An empty session may not be persisted.' },
    { capability: 'interactions.form.schema', status: 'degraded', reason: 'Native schema loss prevents form support.' },
  ].filter(({ capability }) => capability !== overrides.omitClaudeDegradation);
  if (overrides.invalidClaudeDegradation === 'duplicate') claudeDegradations.push({ ...claudeDegradations[0]! });
  if (overrides.invalidClaudeDegradation === 'extra') claudeDegradations.push({ capability: 'events.unknown', status: 'degraded', reason: 'Undeclared.' });
  if (overrides.invalidClaudeDegradation === 'wrong-status') claudeDegradations[0]!.status = 'unsupported';
  if (overrides.invalidClaudeDegradation === 'malformed') claudeDegradations[0]!.reason = '';
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
    {
      providerId: 'claude',
      native: { name: overrides.claudeName ?? 'claude-code', version: overrides.claudeVersion ?? '2.1.247', revision: overrides.claudeRevision ?? null },
      ...(!overrides.omitClaudeSdk ? { sdk: { name: overrides.claudeSdkName ?? '@anthropic-ai/claude-agent-sdk', version: overrides.claudeSdkVersion ?? '0.3.247' } } : {}),
      degradations: claudeDegradations,
    },
    {providerId: 'copilot', native: {name: 'github-copilot-cli', version: '1.0.83', revision: null}, sdk: {name: '@github/copilot-sdk', version: '1.0.11'}, degradations: copilotCapabilities.map(capability => ({capability, status: 'degraded', reason: 'Accepted bounded native integration scope.'}))},
  ];
  return {
    schemaVersion: 1,
    protocolVersion: '1.4.0',
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
