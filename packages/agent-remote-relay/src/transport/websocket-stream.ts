import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { PROTOCOL_VERSION, encodeServerMessage } from '@agent-remote-controller/agent-remote-protocol';
import { WebSocketServer, WebSocket } from 'ws';

import type { AgentRemoteRelay } from '../relay.js';
import { createSessionWire } from '../session-wire.js';
import { hasRequestAccess, type AgentRemoteRequestAccessPolicy } from './request-access-policy.js';

export interface AgentRemoteWebSocketStream {
  close(): Promise<void>;
}

export interface AgentRemotePrincipal {
  subject: string;
  [claim: string]: unknown;
}

export type AgentRemoteAuthorizationAction = 'attach' | 'read_resource' | 'resolve_resource';

export interface AgentRemoteAuthorizationContext {
  principal: AgentRemotePrincipal;
  agentId: string;
  action: AgentRemoteAuthorizationAction;
  request: IncomingMessage;
}

export interface AgentRemoteWebSocketAuthorizer {
  authenticate(request: IncomingMessage): AgentRemotePrincipal | undefined | Promise<AgentRemotePrincipal | undefined>;
  authorize(context: AgentRemoteAuthorizationContext): boolean | Promise<boolean>;
}

export interface AgentRemoteWebSocketStreamOptions {
  authorizer?: AgentRemoteWebSocketAuthorizer;
  accessPolicy?: AgentRemoteRequestAccessPolicy;
}

export function attachAgentRemoteWebSocketStream(
  server: Server,
  relay: AgentRemoteRelay,
  options: AgentRemoteWebSocketStreamOptions = {},
): AgentRemoteWebSocketStream {
  const sockets = new Set<WebSocket>();
  const websocketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    void upgrade(request, socket, head).catch(() => rejectUpgrade(socket, 403, 'Forbidden'));
  });

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!await hasRequestAccess(options.accessPolicy, request)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    let agentId: string;
    try {
      const url = new URL(request.url ?? '/', 'http://relay.local');
      const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
      if (!match) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      agentId = decodeURIComponent(match[1] as string);
      if (!agentId) throw new Error('empty Agent identity');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    void authorizeUpgrade(request, agentId).then((principal) => {
      if (!principal) return;
      try {
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
          try {
            acceptConnection(websocket, agentId, principal, request);
          } catch {
            websocket.close(1008, 'Agent was not found');
          }
        });
      } catch {
        rejectUpgrade(socket, 400, 'Bad Request');
      }
    }).catch(() => rejectUpgrade(socket, 403, 'Forbidden'));
  }

  async function authorizeUpgrade(
    request: IncomingMessage,
    agentId: string,
  ): Promise<AgentRemotePrincipal | undefined> {
    const authorizer = options.authorizer;
    if (!authorizer) {
      rejectUpgrade(request.socket, 401, 'Unauthorized');
      return undefined;
    }
    let principal: AgentRemotePrincipal | undefined;
    try {
      principal = await authorizer.authenticate(request);
    } catch {
      rejectUpgrade(request.socket, 401, 'Unauthorized');
      return undefined;
    }
    if (!principal || principal.subject.length === 0) {
      rejectUpgrade(request.socket, 401, 'Unauthorized');
      return undefined;
    }
    if (!await authorizer.authorize({ principal, agentId, action: 'attach', request })) {
      rejectUpgrade(request.socket, 403, 'Forbidden');
      return undefined;
    }
    return principal;
  }

  function acceptConnection(
    socket: WebSocket,
    agentId: string,
    principal: AgentRemotePrincipal,
    request: IncomingMessage,
  ): void {
    sockets.add(socket);
    const wire = createSessionWire(() => relay.requireAgent(agentId), (json) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(json);
    }, {
      authorize: async (action) => {
        try {
          return await options.authorizer!.authorize({ principal, agentId, action, request });
        } catch {
          return false;
        }
      },
      onFailure: ({ kind }) => {
        if (kind === 'manager_event_buffer_overflow') {
          socket.close(1013, 'Agent event buffer overflowed');
          return;
        }
        socket.close(1011, 'Agent Remote event delivery failed');
      },
    });
    let receiving = Promise.resolve();

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        sendProtocolError(socket, 'binary_message_unsupported', 'Agent Remote messages must be JSON text.', true);
        return;
      }
      receiving = receiving
        .then(() => wire.receive(data.toString()))
        .catch(() => socket.close(1011, 'Agent Remote session failed'));
    });

    socket.once('close', () => {
      wire.close();
      sockets.delete(socket);
    });
  }

  return {
    async close(): Promise<void> {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    },
  };
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

function sendProtocolError(socket: WebSocket, code: string, message: string, recoverable: boolean): void {
  const encoded = encodeServerMessage({
    protocolVersion: PROTOCOL_VERSION,
    type: 'protocol_error',
    payload: { code, message, recoverable },
  });
  if (encoded.status === 'rejected') {
    socket.close(1011, 'Agent Remote serialization failed');
    return;
  }
  socket.send(encoded.json);
}
