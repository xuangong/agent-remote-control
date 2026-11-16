/**
 * What a Controller remembers about a settled resource so that its id stays readable after a restart: where the bytes came
 * from and which bytes they were. The id itself is derived, so the index holds nothing that makes an id guessable.
 */
export interface DurableResourceEntry {
  agentId: string;
  resourceId: string;
  normalizedLocator: string;
  /** What the session's resource reader is asked for. */
  readLocator: string;
  sha256: string;
}

export interface ResourceIdIndex {
  get(agentId: string, resourceId: string): DurableResourceEntry | undefined;
  put(entry: DurableResourceEntry): void;
}
