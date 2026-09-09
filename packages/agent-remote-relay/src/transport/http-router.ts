import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentRemoteRelay } from '../relay.js';
import { hasRequestAccess, type AgentRemoteRequestAccessPolicy } from './request-access-policy.js';
import {
  agentRemoteHttpError, agentRemoteHttpFailure, executeAgentRemoteHttpRequest,
  type AgentRemoteHttpResult,
} from './http-executor.js';

export type AgentRemoteHttpRouter = (request: IncomingMessage, response: ServerResponse) => void;
export type AgentRemoteHttpMutationDecision =
  | { status: 'allowed' }
  | { status: 'rejected'; httpStatus: number; code: string; message: string };
export interface AgentRemoteHttpMutationPolicy {
  validate(request: IncomingMessage): AgentRemoteHttpMutationDecision;
}
export interface AgentRemoteHttpRouterOptions {
  mutationPolicy?: AgentRemoteHttpMutationPolicy;
  accessPolicy?: AgentRemoteRequestAccessPolicy;
}

export function createAgentRemoteHttpRouter(
  relay: AgentRemoteRelay,
  options: AgentRemoteHttpRouterOptions = {},
): AgentRemoteHttpRouter {
  return (request, response) => {
    void route(request).then((result) => send(response, result)).catch((error: unknown) => {
      if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
      else send(response, agentRemoteHttpFailure(error));
    });
  };

  async function route(request: IncomingMessage): Promise<AgentRemoteHttpResult> {
    if (!await hasRequestAccess(options.accessPolicy, request)) {
      return agentRemoteHttpError(401, 'unauthorized', 'Relay authentication is required.', false);
    }
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';
    const url = new URL(path, 'http://relay.local');
    const mutation = method === 'POST' && (url.pathname === '/v1/sessions' || url.pathname === '/v1/sessions/resume');
    if (mutation) {
      const decision = options.mutationPolicy?.validate(request);
      if (decision?.status === 'rejected') {
        return agentRemoteHttpError(decision.httpStatus, decision.code, decision.message, false);
      }
    }
    const chunks: Buffer[] = [];
    let length = 0;
    if (mutation) {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > 1_048_576) return agentRemoteHttpError(400, 'request_body_too_large', 'Relay request body exceeds one megabyte.', true);
        chunks.push(buffer);
      }
    }
    return executeAgentRemoteHttpRequest(relay, { method, path, body: Buffer.concat(chunks).toString('utf8') });
  }
}

function send(response: ServerResponse, result: AgentRemoteHttpResult): void {
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(result.body),
  });
  response.end(result.body);
}
