/** Minimum native API version required by the OpenCode adapter. */
export const MIN_OPENCODE_VERSION = '2.0.25';

/** The CLI decorates its version; server API identity does not. */
export function parseOpenCodeCliVersion(display: string): string | undefined {
  return /^(?:opencode\s+)?v?(\d+\.\d+\.\d+)$/i.exec(display.trim())?.[1];
}

export function supportsOpenCodeVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!match && Number(match[1]) === 2 && (Number(match[2]) > 0 || Number(match[3]) >= 25);
}

export function openCodeVersionIssue(version: unknown): { code: string; message: string } | undefined {
  if (supportsOpenCodeVersion(version)) return undefined;
  const major = typeof version === 'string' ? /^(\d+)\.\d+\.\d+$/.exec(version)?.[1] : undefined;
  const requirement = `OpenCode 2.x (${MIN_OPENCODE_VERSION} or newer)`;
  return major !== undefined && Number(major) !== 2
    ? { code: 'opencode_api_unsupported', message: `OpenCode ${version} uses a different server API. This Controller requires ${requirement}.` }
    : { code: 'opencode_version_unsupported', message: `This Controller requires ${requirement}.` };
}
