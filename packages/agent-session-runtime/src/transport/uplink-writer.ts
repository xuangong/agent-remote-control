interface UplinkWriteSink {
  send(json: string, callback: (error?: Error) => void): void;
}

interface UplinkWriterOptions {
  maxMessages: number;
  maxBytes: number;
  writeTimeoutMs: number;
  onFailure(error: Error): void;
}

export function createUplinkWriter(sink: UplinkWriteSink, options: UplinkWriterOptions): {
  send(json: string): void;
  close(): void;
} {
  const queue: Array<{ json: string; bytes: number }> = [];
  let totalBytes = 0, count = 0;
  let writing = false, closed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    queue.length = 0;
    totalBytes = 0;
    count = 0;
  }

  function fail(error: Error): void {
    if (closed) return;
    close();
    options.onFailure(error);
  }

  function flush(): void {
    if (writing || closed) return;
    const next = queue.shift();
    if (!next) return;
    writing = true;
    deadline = setTimeout(() => fail(new Error('Plugin uplink write deadline exceeded.')), options.writeTimeoutMs);
    try {
      sink.send(next.json, (error) => {
        if (closed) return;
        clearTimeout(deadline);
        if (error) { fail(error); return; }
        writing = false;
        count -= 1;
        totalBytes -= next.bytes;
        flush();
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Plugin uplink write failed.'));
    }
  }

  return {
    send(json: string): void {
      if (closed) return;
      const bytes = Buffer.byteLength(json);
      if (count >= options.maxMessages || totalBytes + bytes > options.maxBytes) {
        fail(new Error('Plugin uplink output capacity exceeded.'));
        return;
      }
      queue.push({ json, bytes });
      count += 1;
      totalBytes += bytes;
      flush();
    },
    close,
  };
}
