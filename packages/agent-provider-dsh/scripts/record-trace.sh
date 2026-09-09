#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <raw-observations.ndjson> <output.dsh-trace.ndjson>" >&2
  exit 64
fi

input_path=$1
output_path=$2
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

INPUT_PATH=$input_path OUTPUT_PATH=$output_path SCRIPT_DIR=$script_dir node --input-type=module <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const inputPath = process.env.INPUT_PATH;
const outputPath = process.env.OUTPUT_PATH;
const scriptDir = process.env.SCRIPT_DIR;
if (!inputPath || !outputPath || !scriptDir) throw new Error('Input and output paths are required.');
const { DshRecordingPlugin, DshTraceRecorder, encodeDshTrace } = await import(pathToFileURL(join(scriptDir, '../dist/index.js')).href);
const input = await readFile(inputPath, 'utf8');
if (input.length === 0 || !input.endsWith('\n')) throw new Error('Raw recording input is truncated or empty.');
const lines = input.slice(0, -1).split('\n');
if (lines.some((line) => line.length === 0)) throw new Error('Raw recording input contains an empty line.');
const [headerLine, ...observationLines] = lines;
const header = JSON.parse(headerLine);
if (header.type !== 'trace_header') throw new Error('The first raw recording line must be a trace_header.');
const recorder = new DshTraceRecorder(header);
const plugin = new DshRecordingPlugin(recorder);
for (const line of observationLines) plugin.record(JSON.parse(line));
await writeFile(outputPath, encodeDshTrace(recorder.trace));
NODE
