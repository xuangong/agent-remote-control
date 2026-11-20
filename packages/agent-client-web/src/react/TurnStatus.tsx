import type { ReactNode } from 'react';
import { elapsedWords, liveStatus, type Turn } from '@orchardworks/agent-client';
import { StatusLine } from '../primitives/StatusLine.js';
import { useTranslate } from './locale.js';
import { useVisibleClock } from './visible-clock.js';

/**
 * The live line of a running turn (I3 plan, decision 6): what the assistant is doing in one sentence ("Chief is running
 * tests"), and "working" with the time since the turn started and the progress of its latest todo. Without a loaded turn it
 * says the assistant is working.
 */
export function TurnStatus({ name, turn, startedAt, avatar }: { name: string; turn?: Turn; startedAt?: string | null; avatar?: ReactNode }) {
  const t = useTranslate();
  const started = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  const timed = Number.isFinite(started);
  const now = useVisibleClock(timed);
  const status = turn ? liveStatus(name, turn, t) : { sentence: t('status.working', { name }) };
  const detail = [t('status.detail'), ...(timed ? [elapsedWords(Math.max(0, (now - started) / 1000), t)] : []), ...(status.progress ? [status.progress] : [])].join(' · ');
  return <StatusLine className="agent-turn-status" avatar={avatar} sentence={status.sentence} detail={detail} live />;
}
