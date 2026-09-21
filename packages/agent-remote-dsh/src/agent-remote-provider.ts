import type { Context } from '@deepseek-ai/cordis';
import {
  createCordisDshRuntime,
  createLiveDshProvider,
  type CordisDshRuntimeOptions,
  type DshToolRegistry,
  type LiveDshProvider,
} from '@orchardworks/agent-provider-dsh';

export interface DshAgentRemoteProviderOptions {
  setup?: CordisDshRuntimeOptions['setup'];
  interactions?: CordisDshRuntimeOptions['interactions'];
  tools?: DshToolRegistry;
}

export function createDshAgentRemoteProvider(
  context: Context,
  options: DshAgentRemoteProviderOptions = {},
): LiveDshProvider {
  const runtime = createCordisDshRuntime({
    context,
    ...(options.setup ? { setup: options.setup } : {}),
    ...(options.interactions ? { interactions: options.interactions } : {}),
  });
  return createLiveDshProvider({ runtime, ...(options.tools ? { tools: options.tools } : {}) });
}

export { mountSharedDshPreset, type DshSharedWebServices } from './shared-web-session.js';
