/** Single-consumer channel owned by a native session. */
export class Channel<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;
  push(value: T): void { if (this.ended) throw new Error('Session channel is closed.'); this.values.push(value); this.wake?.(); }
  close(): void { this.ended = true; this.wake?.(); }
  fail(error: Error): void { this.failure = error; this.close(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.values.length) yield this.values.shift()!;
      else if (this.ended) { if (this.failure) throw this.failure; return; }
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

export async function deadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
