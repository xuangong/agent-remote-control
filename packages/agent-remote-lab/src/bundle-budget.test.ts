import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { measureBundle } from '../bundle-budget.js';

// Random text does not compress, so its gzip size is close to its length.
const code = (bytes: number) => randomBytes(bytes).toString('base64').slice(0, bytes);
const chunks = [
  { fileName: 'assets/index-a.js', name: 'index', isEntry: true, code: code(20_000) },
  { fileName: 'assets/App-b.js', name: 'App', isEntry: false, code: code(50_000) },
  { fileName: 'assets/jsQR-c.js', name: 'jsQR', isEntry: false, code: code(40_000) },
];

it('measures each chunk gzip-compressed and passes the chunks within their budgets', () => {
  const result = measureBundle(chunks, [{ chunk: 'entry', gzipBytes: 30_000 }, { chunk: 'App', gzipBytes: 60_000 }]);
  expect(result.exceeded).toEqual([]);
  expect(result.chunks.map(chunk => chunk.name)).toEqual(['index', 'App', 'jsQR']);
  for (const chunk of result.chunks) expect(chunk.gzipBytes).toBeGreaterThan(0);
});

it('names the chunk over its budget and a budget whose chunk no longer exists', () => {
  const result = measureBundle(chunks, [{ chunk: 'entry', gzipBytes: 10_000 }, { chunk: 'Workbench', gzipBytes: 60_000 }]);
  expect(result.exceeded).toHaveLength(2);
  expect(result.exceeded[0]).toMatch(/^assets\/index-a\.js is \d+\.\d KB gzip, over its 10\.0 KB budget \(entry\)/);
  expect(result.exceeded[1]).toBe('No chunk Workbench to measure: update the bundle budget with the chunk it means.');
});

it('compresses repetitive code well below its length', () => {
  const [chunk] = measureBundle([{ fileName: 'a.js', name: 'App', isEntry: false, code: 'const a = 1;\n'.repeat(10_000) }], []).chunks;
  expect(chunk!.gzipBytes).toBeLessThan(2_000);
});
