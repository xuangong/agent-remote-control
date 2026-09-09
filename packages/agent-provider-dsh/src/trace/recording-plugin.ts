import type { DshNativeObservation } from '../native.js';

import { DshTraceRecorder } from './recorder.js';

export class DshRecordingPlugin {
  constructor(private readonly recorder: DshTraceRecorder) {}

  record(observation: DshNativeObservation): void {
    this.recorder.record(observation);
  }
}
