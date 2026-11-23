import { useSyncExternalStore } from 'react';
import { assistantProcessChoice, effectiveProcessMode, readProcessMode, type ProcessMode } from '@orchardworks/agent-client';
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';

/**
 * Where the process mode and the letters choice live (I3 plan, decision 4): the default for every assistant is this device's
 * (`agent-remote:process-mode`, absent means Concise), an assistant's own choice is its bot details at the Relay (per
 * account), and whether letters show is this device's (`agent-remote:show-letters`). Both device keys are display choices,
 * not conversation content, so clearing stored conversations keeps them.
 */

export const PROCESS_MODE_KEY = 'agent-remote:process-mode';
export const SHOW_LETTERS_KEY = 'agent-remote:show-letters';

const listeners = new Set<() => void>();
function notify(): void { for (const listener of listeners) listener(); }
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const fromAnotherTab = (event: StorageEvent) => { if (event.key === PROCESS_MODE_KEY || event.key === SHOW_LETTERS_KEY || event.key === null) listener(); };
  window.addEventListener('storage', fromAnotherTab);
  return () => { listeners.delete(listener); window.removeEventListener('storage', fromAnotherTab); };
}
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* A device that cannot store keeps the choice for this page only. */ }
  notify();
}

/** This device's default process mode for every assistant; undefined means Concise. */
export function readDeviceProcessMode(): ProcessMode | undefined { return readProcessMode(read(PROCESS_MODE_KEY)); }
export function writeDeviceProcessMode(mode: ProcessMode): void { write(PROCESS_MODE_KEY, mode); }
export function readLettersVisible(): boolean { return read(SHOW_LETTERS_KEY) !== 'false'; }
export function writeLettersVisible(visible: boolean): void { write(SHOW_LETTERS_KEY, String(visible)); }

export function useDeviceProcessMode(): ProcessMode | undefined {
  return readProcessMode(useSyncExternalStore(subscribe, () => read(PROCESS_MODE_KEY), () => null));
}
export function useLettersVisible(): [boolean, (visible: boolean) => void] {
  return [useSyncExternalStore(subscribe, readLettersVisible, () => true), writeLettersVisible];
}

/** An assistant whose bot details the reader may change: its stored details and how to replace them (`bot.update`). */
export interface ProcessAssistant {
  readonly details: WindowBotDetails | undefined;
  /** Its provider can be a coordinator's on its Host, so the details offer coordinator and plain mode. */
  readonly coordinatorAvailable?: boolean;
  update(details: WindowBotDetails): void;
}

export interface ProcessModeChoice {
  /** The mode the conversation shows: the assistant's own, else this device's default, else Concise. */
  readonly mode: ProcessMode;
  readonly device: ProcessMode;
  /** Chooses for this assistant; absent for a view that is no assistant (a tile whose group has no Bot section). */
  readonly chooseForAssistant?: (mode: ProcessMode) => void;
  readonly chooseForDevice: (mode: ProcessMode) => void;
}

/** The process mode of one conversation and the two places a reader chooses it. */
export function useProcessMode(assistant?: ProcessAssistant): ProcessModeChoice {
  const device = useDeviceProcessMode();
  const own = readProcessMode(assistant?.details?.process);
  return {
    mode: effectiveProcessMode(own, device),
    device: effectiveProcessMode(undefined, device),
    ...(assistant ? { chooseForAssistant: (chosen: ProcessMode) => {
      const { process: _previous, ...rest } = assistant.details ?? {};
      const stored = assistantProcessChoice(chosen, device);
      assistant.update(stored ? { ...rest, process: stored } : rest);
    } } : {}),
    chooseForDevice: writeDeviceProcessMode,
  };
}
