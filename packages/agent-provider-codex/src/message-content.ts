import type { AgentInputPart } from '@agent-remote-controller/agent-provider-sdk';

export type CodexInput = { type: 'text'; text: string; text_elements: never[] } | { type: 'localImage'; path: string };
export function codexMessageInput(parts: readonly AgentInputPart[]): CodexInput[] {
  if (!parts.some(part => part.type === 'image' || part.text.trim())) throw new Error('Codex message must not be empty.');
  return parts.map(part => part.type === 'text'
    ? { type: 'text', text: part.text, text_elements: [] } : { type: 'localImage', path: part.path });
}
