import { describe, expect, it } from 'vitest';

import { DebuggerError } from './errors.js';
import { parseExactJson, readTextInput, resolveOrigin, resolveRelayUrl } from './input.js';
import {
  writeBinary,
  writeFileAtomically,
  writeJson,
  writeText,
  writeStructuredError,
  type AtomicFileOperations,
  type DebuggerIo,
} from './output.js';

function createIo(stdin = ''): DebuggerIo & { stdoutValues: string[]; stderrValues: string[] } {
  const stdoutValues: string[] = [];
  const stderrValues: string[] = [];
  return {
    stdin: async () => stdin,
    readFile: async (path) => path === 'message.txt' ? 'from file' : (() => { throw new Error('missing'); })(),
    stdout: (value) => stdoutValues.push(value),
    stderr: (value) => stderrValues.push(value),
    stdoutValues,
    stderrValues,
  };
}

function thrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw.');
}

describe('debugger input and output', () => {
  it('uses option, environment, then local defaults for Relay and Origin', () => {
    const environment = { BORGEE_REMOTE_URL: 'http://relay.example', BORGEE_REMOTE_ORIGIN: 'http://origin.example' };

    expect(resolveRelayUrl('http://command.example', environment)).toBe('http://command.example');
    expect(resolveRelayUrl(undefined, environment)).toBe('http://relay.example');
    expect(resolveRelayUrl(undefined, { ...environment, AGENT_REMOTE_URL: 'http://standalone.example' })).toBe('http://standalone.example');
    expect(resolveOrigin(undefined, { ...environment, AGENT_REMOTE_ORIGIN: 'http://standalone-origin.example' })).toBe('http://standalone-origin.example');
    expect(resolveRelayUrl(undefined, {})).toBe('http://127.0.0.1:5910');
    expect(resolveOrigin('http://command-origin.example', environment)).toBe('http://command-origin.example');
    expect(resolveOrigin(undefined, environment)).toBe('http://origin.example');
    expect(resolveOrigin(undefined, {})).toBe('http://127.0.0.1:6175');
  });

  it('reads text from an argument, file, or explicit standard input', async () => {
    const io = createIo('from stdin');

    await expect(readTextInput('argument', undefined, io)).resolves.toBe('argument');
    await expect(readTextInput(undefined, 'message.txt', io)).resolves.toBe('from file');
    await expect(readTextInput(undefined, '-', io)).resolves.toBe('from stdin');
  });

  it('forwards cancellation to standard input', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const io = {
      ...createIo(),
      stdin: async (signal?: AbortSignal) => {
        observedSignal = signal;
        return 'from stdin';
      },
    };

    await expect(readTextInput(undefined, '-', io, controller.signal)).resolves.toBe('from stdin');
    expect(observedSignal).toBe(controller.signal);
  });

  it('rejects missing or ambiguous text input without exposing file content', async () => {
    const io = createIo();

    await expect(readTextInput(undefined, undefined, io)).rejects.toMatchObject({ code: 'message_required', exitCode: 2 });
    await expect(readTextInput('argument', 'message.txt', io)).rejects.toMatchObject({ code: 'message_source_ambiguous', exitCode: 2 });
    await expect(readTextInput(undefined, 'missing.txt', io)).rejects.toMatchObject({ code: 'input_file_unreadable', exitCode: 2 });
  });

  it('parses exactly one JSON value', () => {
    expect(parseExactJson<{ value: number }>(" {\n \"value\": 1\n} ")).toEqual({ value: 1 });
    expect(thrown(() => parseExactJson('{"value":1} trailing'))).toMatchObject({ code: 'invalid_json', exitCode: 2 });
  });

  it('keeps JSON and JSONL stdout machine-readable', () => {
    const io = createIo();

    writeJson(io, { value: 1 });
    writeJson(io, { value: 2 });
    writeJson(io, { value: 3 });

    expect(io.stdoutValues).toEqual(['{"value":1}\n', '{"value":2}\n', '{"value":3}\n']);
    expect(io.stderrValues).toEqual([]);
  });

  it('rejects top-level values that cannot form a JSON or JSONL document', () => {
    const io = createIo();

    expect(thrown(() => writeJson(io, undefined))).toMatchObject({ code: 'invalid_json_output', exitCode: 2 });
    expect(io.stdoutValues).toEqual([]);
  });

  it('requires explicit byte output and writes structured errors to stderr', () => {
    const io = createIo();
    const error = new DebuggerError(4, 'agent_not_found', 'Agent was not found.', true);

    expect(thrown(() => writeBinary(io, new Uint8Array([1]), false))).toMatchObject({ code: 'binary_stdout_requires_explicit_output' });
    writeStructuredError(io, error);

    expect(io.stderrValues).toEqual(['{"error":{"code":"agent_not_found","message":"Agent was not found.","recoverable":true}}\n']);
  });

  it('classifies local stdout write failures as invalid local output', () => {
    const io = { ...createIo(), stdout: () => { throw new Error('stdout closed'); }, stdoutBytes: () => { throw new Error('stdout closed'); } };

    expect(thrown(() => writeText(io, 'plain text'))).toMatchObject({ code: 'output_write_failed', exitCode: 2 });
    expect(thrown(() => writeJson(io, { value: 1 }))).toMatchObject({ code: 'output_write_failed', exitCode: 2 });
    expect(thrown(() => writeBinary(io, new Uint8Array([1]), true))).toMatchObject({ code: 'output_write_failed', exitCode: 2 });
  });

  it('writes resource files through a same-directory temporary file and atomic rename', async () => {
    const events: string[] = [];
    const files = new Map<string, Uint8Array>();
    const operations: AtomicFileOperations = {
      async writeFile(path, bytes) {
        events.push(`write:${path}`);
        files.set(path, bytes);
      },
      async rename(from, to) {
        events.push(`rename:${from}:${to}`);
        files.set(to, files.get(from) as Uint8Array);
        files.delete(from);
      },
      async unlink(path) {
        events.push(`unlink:${path}`);
        files.delete(path);
      },
    };

    await writeFileAtomically('/work/result.bin', new Uint8Array([1, 2, 3]), new AbortController().signal, operations);

    expect(files.get('/work/result.bin')).toEqual(new Uint8Array([1, 2, 3]));
    expect(events[0]).toMatch(/^write:\/work\/\.result\.bin\./);
    expect(events[1]).toMatch(/^rename:\/work\/\.result\.bin\..*:\/work\/result\.bin$/);
  });

  it('cleans a failed temporary write without changing an existing destination', async () => {
    const files = new Map<string, Uint8Array>([['/work/result.bin', new Uint8Array([9])]]);
    const operations: AtomicFileOperations = {
      async writeFile(path) {
        files.set(path, new Uint8Array([1]));
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      },
      async rename() {
        throw new Error('rename must not run');
      },
      async unlink(path) {
        files.delete(path);
      },
    };

    await expect(writeFileAtomically(
      '/work/result.bin',
      new Uint8Array([1, 2, 3]),
      new AbortController().signal,
      operations,
    )).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(files).toEqual(new Map([['/work/result.bin', new Uint8Array([9])]]));
  });

  it('cleans a canceled temporary write without changing an existing destination', async () => {
    const controller = new AbortController();
    const files = new Map<string, Uint8Array>([['/work/result.bin', new Uint8Array([9])]]);
    const operations: AtomicFileOperations = {
      async writeFile(path, _bytes, options) {
        files.set(path, new Uint8Array([1]));
        return new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      },
      async rename() {
        throw new Error('rename must not run');
      },
      async unlink(path) {
        files.delete(path);
      },
    };

    const pending = writeFileAtomically('/work/result.bin', new Uint8Array([1, 2, 3]), controller.signal, operations);
    controller.abort(new DebuggerError(130, 'interrupted', 'Command was interrupted.', true));

    await expect(pending).rejects.toMatchObject({ code: 'interrupted', exitCode: 130 });
    expect(files).toEqual(new Map([['/work/result.bin', new Uint8Array([9])]]));
  });
});
