import { type RelayDiagnostic } from '@orchardworks/agent-remote-protocol/model';
import { type Host } from './broker-types.js';

export function diagnosticOperation(path: string): RelayDiagnostic['operation'] {
  const pathname=path.split('?')[0]!;
  if(pathname.startsWith('/remote/catalog'))return 'catalog';
  if(pathname.endsWith('/attach'))return 'attach';
  if(pathname==='/remote/create')return 'create';
  if(pathname==='/remote/controller-update')return 'controller_update';
  if(pathname.startsWith('/remote/previews'))return 'preview';
  if(pathname.startsWith('/v1/sessions/'))return 'session_read';
  return 'other';
}
export function diagnosticCloseReason(reason:string): RelayDiagnostic['reason'] {
  switch(reason) {
    case 'Host heartbeat timed out': return 'heartbeat_timeout';
    case 'Host heartbeat delivery failed': return 'heartbeat_delivery_failed';
    case 'Host transport failed': return 'transport_error';
    case 'Credential expired': return 'credential_expired';
    case 'Device credential revoked': return 'access_revoked';
    default: return 'protocol_error';
  }
}
