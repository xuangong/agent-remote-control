/** Minimum native API version required by the OpenCode adapter. */
export const MIN_OPENCODE_VERSION = '1.18.18';

export function supportsOpenCodeVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!match && (Number(match[1]) > 1 || Number(match[1]) === 1
    && (Number(match[2]) > 18 || Number(match[2]) === 18 && Number(match[3]) >= 18));
}
