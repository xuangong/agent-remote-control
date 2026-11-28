import type { AssistantStatus } from '@orchardworks/agent-client';
import type { WorkbenchTile } from './bot-workbench.js';

/** What a folded tile says: its state as the assistant list says it, and one line of what it is doing or did last. */
export function tileStatus(tile: Pick<WorkbenchTile, 'state' | 'currentStep' | 'lastWork'>): AssistantStatus {
  const sentence = tile.currentStep ?? tile.lastWork ?? '';
  if (tile.state === 'needs_input') return { state: 'needs_you', mood: 'needs_you', sentence };
  if (tile.state === 'working' || tile.state === 'queued') return { state: 'working', mood: 'working', sentence };
  if (tile.state === 'ended') return { state: 'ended', mood: 'idle', sentence };
  return { state: 'idle', mood: 'idle', sentence };
}
