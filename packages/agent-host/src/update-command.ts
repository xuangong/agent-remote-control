import { randomUUID } from 'node:crypto';
import { controllerReleases } from '@orchardworks/agent-remote-hosted';
import { compareControllerVersions, isControllerVersion, releaseCoversHost, type ControllerIdentity, type ControllerRelease, type ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';

type ManagementCall = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function runControllerUpdate(args: string[], options: {
  call: ManagementCall; print(text: string): void;
  release?: (version?: string) => Promise<ControllerRelease | null>;
}): Promise<void> {
  let check = false, yes = false, clean = false, version: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--clean') clean = true;
    else if (args[i] === '--yes') yes = true;
    else if (args[i] === '--version' && isControllerVersion(args[i + 1])) version = args[++i];
    else throw new Error('Usage: update --check [--version X.Y.Z] | update --version X.Y.Z --yes [--clean]');
  }
  if (!check && (!yes || !version)) throw new Error('Updating requires --version X.Y.Z --yes. Use install.sh for an interactive confirmation.');
  const info = await options.call({ action: 'controller-info' });
  const identity = info.identity as ControllerIdentity | undefined;
  if (!identity) throw new Error('This Controller has no release identity. Install a published release first.');
  const release = await (options.release ?? (v => v ? controllerReleases.version(v) : controllerReleases.latest()))(version);
  const compatible = identity.remoteUpdate && !!release && releaseCoversHost(release, identity);
  const available = compatible && compareControllerVersions(release.version, identity.version) > 0;
  const canClean = info.cleanInstall === true && compatible && compareControllerVersions(release.version, identity.version) >= 0;
  const message = !identity.remoteUpdate ? 'This Controller needs a published stable launcher before it can update.' : available ? undefined : 'No compatible newer release for this Controller platform, Node runtime and protocol.';
  if (check) {
    options.print(JSON.stringify({ current: identity.version, version: release?.version, available, canClean, message }) + '\n');
    return;
  }
  if (!(clean ? canClean : available) || !release) throw new Error(clean && !canClean ? 'Clean install is unavailable for this launcher or release.' : message);
  const operationId = randomUUID();
  let status = await options.call({ action: 'controller-update', version: release.version, operationId, ...(clean ? { clean: true } : {}) }) as unknown as ControllerUpdateStatus;
  const deadline = Date.now() + 420000;
  let lastPhase: string | undefined;
  while (true) {
    if (status.phase === 'failed') throw new Error(status.message ?? 'Controller update failed. Inspect update status before retrying.');
    if (status.phase === 'succeeded') { options.print(`Controller ${release.version} update completed.\n`); return; }
    if (status.phase === 'waiting') { options.print('Update installed and queued for a safe restart window. Follow progress on the website; this is not yet an activated update.\n'); return; }
    if (status.phase !== lastPhase) { options.print(`Controller update: ${status.phase}.\n`); lastPhase = status.phase; }
    if (Date.now() >= deadline) throw new Error('Update outcome is not yet confirmed. Inspect the website update status before retrying; the request was not cancelled.');
    await new Promise(resolve => setTimeout(resolve, 1000));
    let next: Record<string, unknown> | undefined;
    try {
      next = await options.call({ action: 'controller-info' });
    } catch (error) {
      // A launcher activation replaces the management socket. Never replay the mutation.
      if (status.phase !== 'restarting' && status.phase !== 'downloading') throw error;
    }
    if (!next) continue;
    const observed = next.status as ControllerUpdateStatus | undefined;
    if (observed?.operationId !== operationId || observed.version !== release.version) throw new Error('Controller update status changed.');
    status = observed;
  }
}
