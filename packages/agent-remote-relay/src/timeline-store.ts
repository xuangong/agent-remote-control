import type { AgentTimelineItem } from '@borgee/agent-provider-sdk';
import type { ResourceBinding, TimelineCursor } from '@borgee/agent-remote-protocol';

export interface CanonicalTimelineRow {
  epoch: string;
  seq: number;
  providerId: string;
  sourceKey: string;
  nativeRevision?: number;
  occurredAt: number;
  timestamp: string;
  turnId?: string;
  item: AgentTimelineItem;
  resources: ResourceBinding[];
}

export type TimelineRowInput = Omit<CanonicalTimelineRow, 'epoch' | 'seq' | 'timestamp' | 'resources'> & {
  resources?: ResourceBinding[];
};

export type TimelineAppendResult = {
  status: 'appended';
  row: CanonicalTimelineRow;
} | {
  status: 'duplicate';
  row: CanonicalTimelineRow;
};

export class TimelineStore {
  private readonly timelineRows: CanonicalTimelineRow[] = [];
  private readonly rowsBySourceRevision = new Map<string, Map<number | null, CanonicalTimelineRow>>();

  constructor(readonly epoch: string) {
    if (epoch.length === 0) throw new Error('Timeline epoch must be non-empty.');
  }

  get cursor(): TimelineCursor {
    return { epoch: this.epoch, seq: this.timelineRows.length };
  }

  append(input: TimelineRowInput): TimelineAppendResult {
    const revision = input.nativeRevision ?? null;
    const sourceRevisions = this.rowsBySourceRevision.get(input.sourceKey);
    const existing = sourceRevisions?.get(revision);
    if (existing) return { status: 'duplicate', row: structuredClone(existing) };

    const row: CanonicalTimelineRow = {
      ...structuredClone(input),
      epoch: this.epoch,
      seq: this.timelineRows.length + 1,
      timestamp: new Date(input.occurredAt).toISOString(),
      resources: structuredClone(input.resources ?? []),
    };
    this.timelineRows.push(row);
    if (sourceRevisions) sourceRevisions.set(revision, row);
    else this.rowsBySourceRevision.set(input.sourceKey, new Map([[revision, row]]));
    return { status: 'appended', row: structuredClone(row) };
  }

  rows(): readonly CanonicalTimelineRow[] {
    return structuredClone(this.timelineRows);
  }

  bindResources(seq: number, resources: readonly ResourceBinding[]): CanonicalTimelineRow {
    const row = this.timelineRows[seq - 1];
    if (!row || row.seq !== seq) throw new Error('Timeline row was not found.');
    row.resources = resources.map((resource) => structuredClone(resource));
    return structuredClone(row);
  }
}
