/** pi has no permission system of its own; the adapter's approval extension asks, or lets every tool call through. */
export type PiPermissionMode = 'ask' | 'allow';
export const isPiPermissionMode = (value: unknown): value is PiPermissionMode => value === 'ask' || value === 'allow';

/** Host-owned storage of the mode a session's owner last confirmed, so a reopened session keeps it. */
export interface PiPermissionModeStore {
  read(sessionId: string): Promise<PiPermissionMode | undefined>;
  write(sessionId: string, mode: PiPermissionMode): Promise<void>;
}
