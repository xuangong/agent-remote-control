/** The replica's reducers, by the part of the state they fold. The public names are unchanged. */
export { createReplicaState, applyAgentSnapshot, applyInteractionRequested, applyInteractionResolved, applyInteractionInvalidated,
  applyInteractionRequestedMessage, applyInteractionResolvedMessage, applyInteractionInvalidatedMessage, applyResourceResponse, applyResourceUpdate } from './snapshot-apply.js';
export { applyTimelineReplacement, restoreFromDevice, resetTimeline, reduceTimelineEvent } from './live-fold.js';
export { applyHistoryPage, applyTimelineResourceBindingReplacement } from './page-fold.js';
