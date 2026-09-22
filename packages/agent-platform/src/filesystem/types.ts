export interface RenameRetryPolicy {
  retries: number;
  delayMs: number;
  maxDelayMs: number;
}

export interface PlatformFilesystem {
  syncDirectory(path: string): Promise<void>;
  rename(source: string, target: string, policy: RenameRetryPolicy): Promise<void>;
}
