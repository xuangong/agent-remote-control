import { isRecord, readString } from './native.js';

export interface CodexCollaborationMode {
  mode: string;
  model?: string;
  reasoningEffort?: string;
  developerInstructions?: string;
}

export interface CodexPlanningModes {
  plan: CodexCollaborationMode;
  normal: CodexCollaborationMode;
}

export function readCodexPlanningModes(value: unknown): CodexPlanningModes | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const modes = value.data.flatMap((entry): CodexCollaborationMode[] => {
    if (!isRecord(entry)) return [];
    const mode = readString(entry.mode);
    if (!mode) return [];
    return [{
      mode, model: readString(entry.model),
      reasoningEffort: readString(entry.reasoning_effort),
      developerInstructions: readString(entry.developer_instructions),
    }];
  });
  const plan = modes.find(({ mode }) => mode === 'plan');
  const normal = modes.find(({ mode }) => mode === 'default' || mode === 'code');
  return plan && normal ? { plan, normal } : undefined;
}
