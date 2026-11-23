// What the Workbench knows of a Host and how it pairs one: the types every feature reads, served by the Relay's Host routes.
import type { HostProviderChange, HostProviderSettings, CodexDaemonRestart, CodexDaemonStatus, ControllerIdentity, ControllerReleaseDiscovery, ControllerUpdateStatus, HostEnvironment, HostStatus, PairingPurpose } from '@orchardworks/agent-remote-protocol';

/** coordinator: the Host runs tasks and gives this provider's sessions the task tools, so its assistants can be coordinators. */
export interface HostProvider { providerId: string; displayName: string; coordinator?: true; daemonControl?: true; sessionRename?: true; sessionReferences?: true; referenceNotes?: true; sessionCommands?: true }
export interface RemoteHost {
  id: string; name: string; online: boolean; managed?: boolean; providers?: HostProvider[]; providerId?: string;
  controller?: ControllerIdentity;
  providerManagement?: true;
  teamManagement?: true;
  /** The Controller answers Host status reads: open sessions, CPU, memory and disks. */
  hostStatus?: true;
  /** The Relay owns this Host's session control; without it the Controller cannot open sessions until it is updated. */
  sessionControl?: true;
  /** The Controller delivers messages that waited for this Host while it was offline; the Relay remembers it while offline. */
  outbox?: 1;
  credentialRotation?: boolean; environment?: HostEnvironment;
  access?: 'owner' | 'shared'; sessionQuota?: { limit: number; used: number };
}
export type { PairingPurpose } from '@orchardworks/agent-remote-protocol';
export interface PairingInvitation { id?: string; key: string; expiresAt: string; serverUrl: string; command?: string; purpose?: PairingPurpose; createdAt?: string }
export interface PairingRecord { id: string; purpose: PairingPurpose; createdAt: string; expiresAt: string; status: 'unused' | 'used' | 'obsolete' | 'revoked'; usedAt?: string; revokedAt?: string; hostId?: string; hostName?: string }
export interface PairingHistory { pairings: PairingRecord[]; availablePurposes?: PairingPurpose[] }
export interface HostStopResult { agentId: string; status: 'cancelled' | 'unsupported' | 'failed'; message?: string }
export interface HostPairingService {
  readonly serverUrl?: string;
  providerSettings?(hostId: string, input?: HostProviderChange): Promise<HostProviderSettings>;
  codexDaemon?(hostId: string, input?: CodexDaemonRestart): Promise<CodexDaemonStatus>;
  controllerRelease?(options?: { refresh?: boolean }): Promise<ControllerReleaseDiscovery>;
  controllerUpdate?(hostId: string, input?: { version: string; operationId: string }): Promise<ControllerUpdateStatus>;
  hostStatus?(hostId: string): Promise<HostStatus>;
  invitation?: PairingInvitation;
  hosts(): Promise<{ hosts: RemoteHost[] }>;
  pair(purpose?: PairingPurpose): Promise<PairingInvitation>;
  pairings?(): Promise<PairingHistory>;
  revokePairing?(id: string): Promise<void>;
  deletePairing?(id: string): Promise<void>;
  revoke?(hostId: string): Promise<void>;
  rotate?(hostId: string): Promise<{ ok: true; status: 'pending' | 'rotated' }>;
  stop?(hostId: string): Promise<{ results: HostStopResult[] }>;
}
