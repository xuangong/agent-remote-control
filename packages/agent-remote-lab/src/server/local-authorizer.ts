import type { IncomingMessage } from 'node:http';

import type {
  AgentRemoteHttpMutationPolicy,
  AgentRemoteWebSocketAuthorizer,
} from '@borgee/agent-remote-relay';

const localSubject = 'local-lab';

export function createLocalLabAuthorizer(labOrigin: string): AgentRemoteWebSocketAuthorizer {
  const exactOrigin = new URL(labOrigin).origin;
  return {
    authenticate(request) {
      if (!isLoopback(request) || request.headers.origin !== exactOrigin) return undefined;
      return { subject: localSubject };
    },
    authorize({ principal, action }) {
      return principal.subject === localSubject && (action === 'attach' || action === 'read_resource');
    },
  };
}

export function createLocalLabMutationPolicy(labOrigin: string): AgentRemoteHttpMutationPolicy {
  const exactOrigin = new URL(labOrigin).origin;
  return {
    validate(request) {
      const origin = request.headers.origin;
      if (!isLoopback(request) || (origin !== undefined && origin !== exactOrigin)) {
        return {
          status: 'rejected', httpStatus: 403, code: 'mutation_forbidden',
          message: 'Lab session mutation is not allowed from this origin.',
        };
      }
      const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return {
          status: 'rejected', httpStatus: 415, code: 'unsupported_media_type',
          message: 'Lab session mutations require application/json.',
        };
      }
      return { status: 'allowed' };
    },
  };
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
