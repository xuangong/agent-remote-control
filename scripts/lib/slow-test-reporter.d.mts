export interface RemeasureRequest { cwd: string; file: string; configFile?: string }
export function readAllowlist(path?: string): Set<string>;
export function remeasureAlone(request: RemeasureRequest): Promise<Map<string, number>>;
export class SlowTestReporter {
  constructor(options?: { enforce?: boolean; allowlist?: string; remeasure?: (request: RemeasureRequest) => Promise<Map<string, number>> });
  onInit(vitest: unknown): void;
  onTestRunEnd(testModules: readonly unknown[]): Promise<void>;
}
