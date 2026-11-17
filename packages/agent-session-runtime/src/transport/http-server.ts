import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AgentRemoteRelay } from '../relay.js';
import { createAgentRemoteHttpRouter, type AgentRemoteHttpMutationPolicy } from './http-router.js';
import { attachAgentRemoteWebSocketStream } from './websocket-stream.js';
import type { AgentRemoteWebSocketAuthorizer } from './websocket-stream.js';
import type { AgentRemoteRequestAccessPolicy } from './request-access-policy.js';

export interface AgentRemoteHttpAddress {
  host: string;
  port: number;
  url: string;
}

export interface AgentRemoteHttpServer {
  readonly server: Server;
  listen(port?: number, host?: string): Promise<AgentRemoteHttpAddress>;
  close(): Promise<void>;
}

export interface AgentRemoteHttpServerOptions {
  /** Resolve a stable authority from trusted authentication state, never from an unverified client field. */
  operationScope?: (request: import('node:http').IncomingMessage) => string | Promise<string>;
  accessPolicy?: AgentRemoteRequestAccessPolicy;
  websocketAuthorizer?: AgentRemoteWebSocketAuthorizer;
  mutationPolicy?: AgentRemoteHttpMutationPolicy;
}

export function createAgentRemoteHttpServer(
  relay: AgentRemoteRelay,
  options: AgentRemoteHttpServerOptions = {},
): AgentRemoteHttpServer {
  const server = createServer(createAgentRemoteHttpRouter(relay, {
    operationScope: options.operationScope ?? (options.websocketAuthorizer ? async request => {
      const principal = await options.websocketAuthorizer!.authenticate(request);
      if (!principal) throw new Error('Authenticated mutation scope is unavailable.');
      return principal.subject;
    } : undefined),
    ...(options.accessPolicy === undefined ? {} : { accessPolicy: options.accessPolicy }),
    ...(options.mutationPolicy === undefined ? {} : { mutationPolicy: options.mutationPolicy }),
  }));
  const websocket = attachAgentRemoteWebSocketStream(server, relay, {
    ...(options.accessPolicy === undefined ? {} : { accessPolicy: options.accessPolicy }),
    ...(options.websocketAuthorizer === undefined ? {} : { authorizer: options.websocketAuthorizer }),
  });

  return {
    server,
    listen(port = 0, host = '127.0.0.1'): Promise<AgentRemoteHttpAddress> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          const address = server.address() as AddressInfo;
          resolve({ host, port: address.port, url: `http://${host}:${address.port}` });
        });
      });
    },
    async close(): Promise<void> {
      await websocket.close();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
