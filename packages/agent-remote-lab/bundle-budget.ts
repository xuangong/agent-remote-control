import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** The most a JavaScript chunk may weigh gzip-compressed: the entry, or a chunk by its Rollup name (`App` for the workbench). */
export interface BundleBudget { chunk: 'entry' | string; gzipBytes: number }
export interface MeasuredChunk { fileName: string; name: string; isEntry: boolean; gzipBytes: number }

/** Gzip sizes of the JavaScript chunks, and a message for each budget a chunk exceeds. */
export function measureBundle(chunks: ReadonlyArray<{ fileName: string; name: string; isEntry: boolean; code: string }>, budgets: readonly BundleBudget[]): { chunks: MeasuredChunk[]; exceeded: string[] } {
  const measured = chunks.map(chunk => ({ fileName: chunk.fileName, name: chunk.name, isEntry: chunk.isEntry, gzipBytes: gzipSync(chunk.code, { level: 9 }).byteLength }));
  const exceeded: string[] = [];
  for (const budget of budgets) {
    const matching = measured.filter(chunk => budget.chunk === 'entry' ? chunk.isEntry : chunk.name === budget.chunk);
    if (!matching.length) exceeded.push(`No chunk ${budget.chunk} to measure: update the bundle budget with the chunk it means.`);
    for (const chunk of matching) if (chunk.gzipBytes > budget.gzipBytes)
      exceeded.push(`${chunk.fileName} is ${kilobytes(chunk.gzipBytes)} gzip, over its ${kilobytes(budget.gzipBytes)} budget (${budget.chunk}). Load what it gained on demand, or raise the budget deliberately.`);
  }
  return { chunks: measured, exceeded };
}
const kilobytes = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;

/**
 * Fails a production build whose entry or workbench chunk exceeds its gzip budget (stage 6): the sign-in entry and the
 * code loaded after sign-in stay small enough for a phone, and a heavy dependency added to them is noticed when built.
 */
export function bundleBudget(budgets: readonly BundleBudget[]): Plugin {
  return {
    name: 'agent-remote-bundle-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap(item => item.type === 'chunk' ? [{ fileName: item.fileName, name: item.name, isEntry: item.isEntry, code: item.code }] : []);
      const { exceeded } = measureBundle(chunks, budgets);
      if (exceeded.length) this.error(exceeded.join('\n'));
    },
  };
}
