export { DshProjector, type DshProjectorOptions, type DshNativeObservation } from './projector.js';
export { type DshTool, type DshToolPresentation, type DshToolRegistry, projectDshToolDetails } from './tools.js';
export { createRecordedDshProvider, type RecordedDshProvider, type RecordedDshSession, type PlaybackClock, type PlaybackMode } from './recorded-provider.js';
export { createLiveDshProvider, type LiveDshProvider } from './live-provider.js';
export { LiveDshSession } from './live-session.js';
export { DshGeneratedResourceReader, normalizeGeneratedResourceLocator } from './generated-resource.js';
export {
  createCordisDshRuntime,
  installDshNativeInteractionBridge,
  type AgentRuntimeInfoValue,
  type CordisDshRuntimeOptions,
  type DshOwnedAgent,
  type DshOwnedRuntimeFeatures,
  type DshStoredImage,
  type DshRuntime,
  type DshRuntimeSetupRequest,
} from './runtime.js';
export { decodeDshTrace, encodeDshTrace, DshTraceCodecError } from './trace/codec.js';
export { createDshWebInteractionAdapter, type DshWebInteractionAdapter } from './web-interactions.js';
export { DshTraceRecorder } from './trace/recorder.js';
export { DshRecordingPlugin } from './trace/recording-plugin.js';
export { dshTraceFormat, type DshTrace, type DshTraceHeader, type DshTraceNativeRecord, type DshTraceRuntimeInfo, type JsonValue } from './trace/schema.js';

export { DshChildSessions, type DshChildContext } from './children.js';
