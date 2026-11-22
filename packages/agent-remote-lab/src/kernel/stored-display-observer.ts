import type { AgentReplica } from '@orchardworks/agent-client';
import type { ControllerLocation } from '@orchardworks/agent-remote-protocol/model';
import { recoveryGeneration } from './conversation-recovery.js';
import { pinStoredSession, saveStoredDisplay } from './stored-display.js';

/**
 * A shared session keeps what this device stores of it at two moments: when a page of the connection was confirmed (its first one, a reconnect's) and when a
 * turn ends. Nothing in between: what a leaving page has not kept, its next open reads again from the stored cursor. The store starts each write in the task that keeps the record, so leaving needs no write.
 */
export function observeStoredDisplay(baseUrl: string, target: ControllerLocation, replica: AgentReplica): () => void {
  const generation = recoveryGeneration(baseUrl);
  const unpin = pinStoredSession(baseUrl, target);
  const save = () => { if (recoveryGeneration(baseUrl) === generation) saveStoredDisplay(baseUrl, target, replica.getState()); };
  // An older page says nothing about the newest window; a forward page and a tail do.
  // Content this connection already confirmed before it knew which session it was is kept now.
  save();
  const stopPages = replica.subscribeHistory((_epoch, direction) => { if (direction !== 'before') save(); });
  let working = !!replica.getState().agent?.activeTurn;
  const stopTurns = replica.subscribe(() => {
    const now = !!replica.getState().agent?.activeTurn;
    if (working && !now) save();
    working = now;
  });
  return () => { stopPages(); stopTurns(); unpin(); };
}
