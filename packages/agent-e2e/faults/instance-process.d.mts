export interface Instance { name: string; directory: string; origin: string; source: string; state: string; workspace: string }
type Exec = (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string }>;
export const controllerCommandSuffix: (source: string) => string;
export function readInstance(options?: { exec?: Exec }): Promise<Instance>;
export function stopController(instance: Instance, options: {
  mode: 'kill' | 'graceful'; ps?: (pid: number) => Promise<string>; signalProcess?: (pid: number, signal: string) => void;
  alive?: (pid: number) => boolean; waitMs?: number; readRuntimeFile?: (instance: Instance) => Promise<{ controllerPid?: number; runnerPid?: number } | undefined>;
}): Promise<{ mode: string; controllerPid: number; runnerStopped: boolean; ms: number }>;
export function journalStoreFiles(instance: Instance): Promise<string[]>;
export function restartInstance(instance: Instance, options: { checkout: string; emptyStore?: boolean; journalLimits?: { sessionBytes?: number; hostBytes?: number; liveOnlyItems?: number }; exec?: Exec; remove?: (file: string, options: { force: boolean }) => Promise<void> }): Promise<{ emptyStore: boolean; removedFiles: number; journalLimits: object | null; ms: number }>;
