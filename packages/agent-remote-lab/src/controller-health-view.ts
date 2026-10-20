export interface ControllerHealthView {
  warnings: Array<{ code: string; severity: 'warning' | 'notice'; message: string }>;
  natives: Array<{ providerId: string; version: string; verified: string; newer: boolean }>;
  launcher?: { managed: boolean; version?: string };
}

const text = (value: unknown, max = 600): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Controllers report health beside their update status; older Controllers omit it and invalid parts are dropped. */
export function readControllerHealth(status: unknown): ControllerHealthView | undefined {
  if (!record(status) || !record(status.health)) return undefined;
  const health = status.health;
  const warnings = (Array.isArray(health.warnings) ? health.warnings : []).slice(0, 20).flatMap(item => record(item) && text(item.code, 64) && text(item.message)
    && (item.severity === 'warning' || item.severity === 'notice') ? [{ code: item.code, severity: item.severity as 'warning' | 'notice', message: item.message }] : []);
  const natives = (Array.isArray(health.natives) ? health.natives : []).slice(0, 8).flatMap(item => record(item) && text(item.providerId, 64) && text(item.version, 64)
    && text(item.verified, 64) && typeof item.newer === 'boolean' ? [{ providerId: item.providerId, version: item.version, verified: item.verified, newer: item.newer }] : []);
  const launcher = record(health.launcher) && typeof health.launcher.managed === 'boolean'
    ? { managed: health.launcher.managed, ...(text(health.launcher.version, 64) ? { version: health.launcher.version } : {}) } : undefined;
  return { warnings, natives, ...(launcher ? { launcher } : {}) };
}
