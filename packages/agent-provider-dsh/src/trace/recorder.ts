import type { DshNativeObservation } from '../native.js';

import { cloneJsonData, type DshTrace, type DshTraceHeader } from './schema.js';

export class DshTraceRecorder {
  readonly trace: DshTrace;
  private firstOccurredAt: number | undefined;

  constructor(header: DshTraceHeader) {
    this.trace = { header: cloneJsonData(header) as unknown as DshTraceHeader, records: [] };
  }

  record(observation: DshNativeObservation): void {
    if (!Number.isSafeInteger(observation.occurredAt) || observation.occurredAt < 0) {
      throw new Error('Recorded DSH observations must have a non-negative safe occurredAt value.');
    }
    if (observation.recordId.length === 0) throw new Error('Recorded DSH observations must have a recordId.');
    const firstOccurredAt = this.firstOccurredAt ?? observation.occurredAt;
    const offset = observation.occurredAt - firstOccurredAt;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Recorded DSH observation time cannot precede the trace start.');
    this.firstOccurredAt = firstOccurredAt;
    this.trace.records.push({
      type: 'native_record',
      ordinal: this.trace.records.length + 1,
      offset,
      recordId: observation.recordId,
      kind: observation.kind,
      payload: cloneJsonData(observation.payload),
    });
  }
}
