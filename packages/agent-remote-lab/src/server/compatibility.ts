import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { PROTOCOL_VERSION } from '@borgee/agent-remote-protocol';

const manifestEnvironment = 'BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST';
const requiredProviderIds = ['claude', 'codex', 'copilot', 'dsh'] as const;
const requiredDegradations: Record<
  (typeof requiredProviderIds)[number],
  ReadonlyArray<{ capability: string; status: ProviderCompatibility['degradations'][number]['status'] }>
> = {
  copilot: [
    {capability: 'native.experimental-rpc', status: 'degraded'},
    {capability: 'controls.settings', status: 'degraded'},
    {capability: 'events.subagent.navigation', status: 'degraded'},
    {capability: 'interactions.callback-identity', status: 'degraded'},
    {capability: 'events.resources-usage', status: 'degraded'},
    {capability: 'controls.immediate-input', status: 'degraded'},
  ],
  claude: [
    { capability: 'events.subagent.navigation', status: 'degraded' },
    { capability: 'events.tool-result.resources', status: 'degraded' },
    { capability: 'controls.queue-steer-commands-settings', status: 'degraded' },
    { capability: 'interactions.restart-recovery', status: 'degraded' },
    { capability: 'sessions.empty-persistence', status: 'degraded' },
    { capability: 'interactions.form.schema', status: 'degraded' },
  ],
  dsh: [
    { capability: 'events.session/title', status: 'degraded' },
    { capability: 'events.user-message.unknown-source', status: 'degraded' },
    { capability: 'events.subagent.navigation', status: 'degraded' },
    { capability: 'events.compaction.failure', status: 'degraded' },
  ],
  codex: [
    { capability: 'interactions.form.schema', status: 'degraded' },
    { capability: 'interactions.restart-recovery', status: 'degraded' },
    { capability: 'events.subagent.navigation', status: 'degraded' },
    { capability: 'events.thread/name', status: 'degraded' },
    { capability: 'events.commandExecution/terminalInteraction', status: 'degraded' },
  ],
};

export interface NativeCompatibility {
  name: string;
  version: string;
  revision: string | null;
}

export interface ProviderCompatibility {
  providerId: string;
  native: NativeCompatibility;
  sdk?: { name: string; version: string };
  degradations: Array<{
    capability: string;
    status: 'unsupported' | 'degraded';
    reason: string;
  }>;
}

export interface CompatibilityManifest {
  schemaVersion: 1;
  protocolVersion: typeof PROTOCOL_VERSION;
  borgee: {
    release: string;
    sourceState: 'working_tree';
    baseRevision: string;
    implementation: {
      algorithm: 'sha256';
      root: string;
      scope: string[];
      digest: string;
    };
  };
  providers: ProviderCompatibility[];
}

export function loadCompatibilityManifest(path?: string): CompatibilityManifest {
  const manifestPath = resolve(path ?? process.env[manifestEnvironment]
    ?? resolve(process.cwd(), 'compatibility.json'));
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read Agent Remote compatibility manifest: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Agent Remote compatibility manifest must have schemaVersion 1.');
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Agent Remote compatibility manifest must have protocolVersion ${PROTOCOL_VERSION}.`);
  }
  const borgee = parseBorgeeCompatibility(value.borgee);
  if (!Array.isArray(value.providers)) {
    throw new Error('Agent Remote compatibility manifest has an invalid release or Provider matrix.');
  }
  const providers = value.providers.map(parseProviderCompatibility);
  if (new Set(providers.map(({ providerId }) => providerId)).size !== providers.length) {
    throw new Error('Agent Remote compatibility manifest must contain unique Provider entries.');
  }
  const providerIds = providers.map(({ providerId }) => providerId).sort();
  if (providerIds.length !== requiredProviderIds.length
    || providerIds.some((providerId, index) => providerId !== requiredProviderIds[index])) {
    throw new Error('Agent Remote compatibility manifest must contain the exact Provider set: claude, codex, copilot, and dsh.');
  }
  for (const provider of providers) validateRequiredDegradations(provider);
  verifyImplementationDigest(manifestPath, borgee);
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    borgee,
    providers,
  };
}

export function requireProviderCompatibility(
  manifest: CompatibilityManifest,
  providerId: string,
): ProviderCompatibility {
  const provider = manifest.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) throw new Error(`Agent Remote compatibility manifest does not include Provider ${providerId}.`);
  return provider;
}

function parseProviderCompatibility(value: unknown): ProviderCompatibility {
  if (!isRecord(value)
    || !isNonEmptyString(value.providerId)
    || !isNativeCompatibility(value.native)
    || !Array.isArray(value.degradations)) {
    throw new Error('Agent Remote compatibility manifest contains an invalid Provider entry.');
  }
  if (value.providerId === 'claude' && (value.native.name !== 'claude-code' || value.native.version !== '2.1.247'
    || value.native.revision !== null || !isRecord(value.sdk) || value.sdk.name !== '@anthropic-ai/claude-agent-sdk'
    || value.sdk.version !== '0.3.247')) {
    throw new Error('Agent Remote compatibility manifest must pin Claude Code 2.1.247 and @anthropic-ai/claude-agent-sdk 0.3.247.');
  }
  if (value.providerId === 'copilot' && (value.native.name !== 'github-copilot-cli' || value.native.version !== '1.0.83'
    || value.native.revision !== null || !isRecord(value.sdk) || value.sdk.name !== '@github/copilot-sdk'
    || value.sdk.version !== '1.0.11')) {
    throw new Error('Agent Remote compatibility manifest must pin Copilot CLI 1.0.83 and @github/copilot-sdk 1.0.11.');
  }
  let sdk: ProviderCompatibility['sdk'];
  if (value.sdk !== undefined) {
    if (!isRecord(value.sdk) || !isNonEmptyString(value.sdk.name) || !isNonEmptyString(value.sdk.version)) {
      throw new Error('Agent Remote compatibility manifest contains an invalid Provider SDK entry.');
    }
    sdk = { name: value.sdk.name, version: value.sdk.version };
  }
  const degradations = value.degradations.map(parseDegradation);
  return {
    providerId: value.providerId,
    native: value.native,
    ...(sdk ? { sdk } : {}),
    degradations,
  };
}

function parseBorgeeCompatibility(value: unknown): CompatibilityManifest['borgee'] {
  if (!isRecord(value)
    || !isNonEmptyString(value.release)
    || value.sourceState !== 'working_tree'
    || !isRevision(value.baseRevision)
    || !isRecord(value.implementation)
    || value.implementation.algorithm !== 'sha256'
    || !isNonEmptyString(value.implementation.root)
    || !Array.isArray(value.implementation.scope)
    || !value.implementation.scope.every(isNonEmptyString)
    || !isDigest(value.implementation.digest)) {
    throw new Error('Agent Remote compatibility manifest has an invalid Borgee working-tree identity.');
  }
  return {
    release: value.release,
    sourceState: 'working_tree',
    baseRevision: value.baseRevision,
    implementation: {
      algorithm: 'sha256',
      root: value.implementation.root,
      scope: [...value.implementation.scope],
      digest: value.implementation.digest,
    },
  };
}

function parseDegradation(value: unknown): ProviderCompatibility['degradations'][number] {
  if (!isRecord(value)
    || !isNonEmptyString(value.capability)
    || (value.status !== 'unsupported' && value.status !== 'degraded')
    || !isNonEmptyString(value.reason)) {
    throw new Error('Agent Remote compatibility manifest contains an invalid degradation entry.');
  }
  return { capability: value.capability, status: value.status, reason: value.reason };
}

function validateRequiredDegradations(provider: ProviderCompatibility): void {
  if (provider.providerId !== 'dsh' && provider.providerId !== 'codex' && provider.providerId !== 'claude' && provider.providerId !== 'copilot') return;
  const displayName = provider.providerId === 'dsh' ? 'DSH' : provider.providerId === 'codex' ? 'Codex' : provider.providerId === 'copilot' ? 'Copilot' : 'Claude';
  const actual = new Map(provider.degradations.map((entry) => [entry.capability, entry.status]));
  if (actual.size !== provider.degradations.length) {
    throw new Error(`Agent Remote compatibility manifest must contain unique degradation capabilities for ${displayName}.`);
  }
  const required = requiredDegradations[provider.providerId];
  const mismatched = required.filter(({ capability, status }) => actual.get(capability) !== status);
  if (provider.degradations.length !== required.length || mismatched.length > 0) {
    throw new Error(`Agent Remote compatibility manifest must contain the exact ${displayName} degradation entries.`);
  }
}

function isNativeCompatibility(value: unknown): value is NativeCompatibility {
  return isRecord(value)
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.version)
    && (value.revision === null || isNonEmptyString(value.revision));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{40}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f\d]{64}$/.test(value);
}

function verifyImplementationDigest(
  manifestPath: string,
  borgee: CompatibilityManifest['borgee'],
): void {
  if (isAbsolute(borgee.implementation.root)) {
    throw new Error('Agent Remote compatibility implementation root must be relative to the manifest.');
  }
  const root = realpathSync(resolve(dirname(manifestPath), borgee.implementation.root));
  const files = collectScopeFiles(root, borgee.implementation.scope);
  const hash = createHash('sha256');
  for (const [path, absolutePath] of files) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(absolutePath));
    hash.update('\0');
  }
  const actual = `sha256:${hash.digest('hex')}`;
  if (actual !== borgee.implementation.digest) {
    throw new Error(`Agent Remote compatibility implementation digest mismatch: expected ${borgee.implementation.digest}, got ${actual}.`);
  }
}

function collectScopeFiles(root: string, scope: readonly string[]): Array<[string, string]> {
  const files = new Map<string, string>();
  for (const entry of scope) {
    if (isAbsolute(entry) || entry.includes('\0')) {
      throw new Error('Agent Remote compatibility implementation scope must contain relative paths.');
    }
    const target = resolve(root, entry);
    const fromRoot = relative(root, target);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('Agent Remote compatibility implementation scope must stay inside its root.');
    }
    collectFiles(root, target, files);
  }
  if (files.size === 0) throw new Error('Agent Remote compatibility implementation scope must contain files.');
  return [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function collectFiles(root: string, target: string, files: Map<string, string>): void {
  const identity = lstatSync(target);
  if (identity.isSymbolicLink()) {
    throw new Error('Agent Remote compatibility implementation scope must not contain symbolic links.');
  }
  if (identity.isDirectory()) {
    for (const child of readdirSync(target).sort()) collectFiles(root, resolve(target, child), files);
    return;
  }
  if (!identity.isFile()) {
    throw new Error('Agent Remote compatibility implementation scope must contain regular files.');
  }
  files.set(relative(root, target).split(sep).join('/'), target);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
