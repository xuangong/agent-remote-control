import type { AgentProviderAdapter } from '@agent-remote-controller/agent-provider-sdk';
import { createAgentRemoteHttpServer, createAgentRemoteRelay } from '@agent-remote-controller/agent-remote-relay';

import { createRemoteHostBroker } from './server/remote-host-broker.js';
import { createSessionDirectory, type SessionDirectorySource } from './server/session-directory.js';

import { createLocalLabAuthorizer, createLocalLabMutationPolicy } from './server/local-authorizer.js';

export interface ProtocolValidationServerOptions {
  providers: readonly AgentProviderAdapter[];
  labOrigin: string;
  directories?: readonly SessionDirectorySource[];
}

export function createProtocolValidationServer(options: ProtocolValidationServerOptions) {
  const directory = createSessionDirectory(options.providers, options.directories);
  const relay = createAgentRemoteRelay({ providers: directory.providers });
  const http = createAgentRemoteHttpServer(relay, {
    websocketAuthorizer: createLocalLabAuthorizer(options.labOrigin),
    mutationPolicy: createLocalLabMutationPolicy(options.labOrigin),
  });
  directory.install(http.server, relay, options.labOrigin);
  const broker = createRemoteHostBroker({ origin: options.labOrigin });
  broker.install(http.server);
  return {
    relay,
    http,
    async close(): Promise<void> {
      await broker.close();
      await http.close();
      await relay.close();
      await directory.close();
    },
  };
}
