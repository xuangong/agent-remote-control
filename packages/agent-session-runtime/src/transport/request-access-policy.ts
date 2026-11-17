import type { IncomingMessage } from 'node:http';

export interface AgentRemoteRequestAccessPolicy {
  authorize(request: IncomingMessage): boolean | Promise<boolean>;
}

export async function hasRequestAccess(
  policy: AgentRemoteRequestAccessPolicy | undefined,
  request: IncomingMessage,
): Promise<boolean> {
  if (!policy) return true;
  try {
    return await policy.authorize(request) === true;
  } catch {
    return false;
  }
}
