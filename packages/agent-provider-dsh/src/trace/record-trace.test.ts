import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/record-trace.sh', import.meta.url));
const header = '{"type":"trace_header","format":"borgee.dsh.trace.v1","sessionId":"recording-script","nativeSessionHeader":{},"runtimeInfo":{"status":"waiting"}}';
const observation = '{"recordId":"record-1","occurredAt":0,"kind":"session_event","payload":{"type":"turn/start","data":{"turn":"turn-1"}}}';

describe('record-trace.sh', () => {
  it.each([
    ['a missing final newline', `${header}\n${observation}`],
    ['an empty line', `${header}\n\n${observation}\n`],
  ])('rejects %s instead of normalizing a damaged capture', async (_description, input) => {
    const directory = await mkdtemp(join(tmpdir(), 'borgee-dsh-trace-'));
    const inputPath = join(directory, 'input.ndjson');
    const outputPath = join(directory, 'output.dsh-trace.ndjson');
    await writeFile(inputPath, input);

    try {
      await expect(execute('/bin/bash', [script, inputPath, outputPath])).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
