import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { createAgentRemoteHttpServer, createAgentRemoteRelay, InputImageStore, InputResourceStore } from '@orchardworks/agent-remote-relay';

import { createRemoteHostBroker } from './server/remote-host-broker.js';
import { createSessionDirectory, type SessionDirectorySource } from './server/session-directory.js';

import { createLocalLabAuthorizer, createLocalLabMutationPolicy } from './server/local-authorizer.js';

export interface ProtocolValidationServerOptions {
  providers: readonly AgentProviderAdapter[];
  labOrigin: string;
  imageDirectory?: string;
  resourceDirectory?: string;
  teamResourceDirectory?: string;
  successionStateDirectory?: string;
  directories?: readonly SessionDirectorySource[];
}

export function createProtocolValidationServer(options: ProtocolValidationServerOptions) {
  const directory = createSessionDirectory(options.providers, options.directories, { successionStateDirectory: options.successionStateDirectory });
  const relay = createAgentRemoteRelay({ providers: directory.providers, operationCache: directory.operationCache, operationLifecycle: directory.operationLifecycle, inputResourceStore: new InputResourceStore({directory:options.resourceDirectory ?? join(homedir(), '.agent-remote-control', 'lab-input-resources')}), inputImageStore: new InputImageStore({ directory: options.imageDirectory ?? join(homedir(), '.agent-remote-control', 'lab-input-images') }) });
  const http = createAgentRemoteHttpServer(relay, {
    // The mutation policy admits both local CLI and exact-origin browser requests.
    operationScope: () => 'local-lab',
    websocketAuthorizer: createLocalLabAuthorizer(options.labOrigin),
    mutationPolicy: createLocalLabMutationPolicy(options.labOrigin),
  });
  directory.install(http.server, relay, options.labOrigin);
  const broker = createRemoteHostBroker({ origin: options.labOrigin, teamResources: new InputResourceStore({directory:options.teamResourceDirectory ?? join(homedir(), '.agent-remote-control', 'lab-team-resources')}) });
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
