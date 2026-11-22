import { useMemo } from 'react';
import type { BotRosterModel } from '../../kernel/bot-roster.js';
import { useSharedFeed, type SharedFeedsSnapshot } from '../../kernel/shared-feeds.js';

/** One projection per frame of the shared feeds and per projection, read by every list and top bar alike. */
const projections = new WeakMap<SharedFeedsSnapshot, WeakMap<object, BotRosterModel>>();
export function projectShared(project: (shared: SharedFeedsSnapshot) => BotRosterModel, shared: SharedFeedsSnapshot): BotRosterModel {
  let byProjection = projections.get(shared);
  if (!byProjection) projections.set(shared, byProjection = new WeakMap());
  const cached = byProjection.get(project);
  if (cached) return cached;
  const model = project(shared);
  byProjection.set(project, model);
  return model;
}

/** A roster that follows the shared feeds itself, so their frames render the list and not the screen around it. */
export function useSharedRoster(model: BotRosterModel, project?: (shared: SharedFeedsSnapshot) => BotRosterModel): BotRosterModel {
  const shared = useSharedFeed(snapshot => project ? snapshot : undefined);
  return useMemo(() => project && shared ? projectShared(project, shared) : model, [project, shared, model]);
}
