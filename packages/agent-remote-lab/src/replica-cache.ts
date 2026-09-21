import { AgentReplica } from '@orchardworks/agent-remote-web';

/** Retains conversation replicas independently from durable drafts and reading positions. */
export class ReplicaCache {
  private readonly replicas = new Map<string, AgentReplica>();
  constructor(private readonly limit = 6, private readonly byteLimit = 24 * 1024 * 1024) {}
  get size(): number { return this.replicas.size; }
  get(key: string): AgentReplica | undefined { return this.replicas.get(key); }
  obtain(key: string): AgentReplica {
    const replica = this.replicas.get(key) ?? new AgentReplica();
    this.replicas.delete(key);
    this.replicas.set(key, replica);
    return replica;
  }
  private readonly sizes = new WeakMap<object, number>();
  private estimate(value: unknown): number {
    if (typeof value === 'string') return value.length * 2;
    if (!value || typeof value !== 'object') return 8;
    const cached = this.sizes.get(value);
    if (cached !== undefined) return cached;
    const size = 32 + Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + this.estimate(item), 0);
    this.sizes.set(value, size);
    return size;
  }
  retain(keys: Iterable<string>): void {
    const protectedKeys = new Set(keys);
    const eligible = [...this.replicas].filter(([key, replica]) => !protectedKeys.has(key) && !replica.getState().outgoingMessages?.length);
    let bytes = eligible.reduce((sum, [, replica]) => sum + this.estimate(replica.getState()), 0);
    let count = eligible.length;
    for (const [key, replica] of eligible) {
      if (count <= this.limit && bytes <= this.byteLimit) break;
      bytes -= this.estimate(replica.getState());
      count--;
      this.replicas.delete(key);
    }
  }
}
