/**
 * The one rule of when a device's stored rows may be read and shown: while this device holds a lease the Relay granted the person and has not refused since.
 * Showing what the device already stores needs no network: the Relay confirms in the background and the rows then update in place. It is not valid before any
 * lease was granted on this device, after a refusal (401 or 403, which also purges the records), or after the workspace was retired. A Relay without accounts
 * has no gate and one person. Writing and talking to the Relay need the Relay's confirmation instead (`WorkspaceReady`).
 */
export interface DisplayLeaseGate {
  /** The Relay granted this device a lease (now, or the one the device cached) and has not refused it since. */
  readonly granted: boolean;
  readonly retired?: boolean;
}

export function displayLeaseValid(gate: DisplayLeaseGate | undefined): boolean {
  if (!gate) return true;
  return gate.granted && !gate.retired;
}
