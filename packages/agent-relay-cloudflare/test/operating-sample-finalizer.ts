import { writeFile } from 'node:fs/promises';

interface OperatingSample {
  outcome: string;
  failures: Record<string, unknown>[];
  finishedAt?: string;
}

export async function finalizeOperatingSample(sample: OperatingSample, path: string,
  cleanup?: () => Promise<void>, primaryFailure?: { error: unknown }) {
  const errors: unknown[] = primaryFailure ? [primaryFailure.error] : [];
  if (primaryFailure) sample.outcome = 'failed';
  if (cleanup) {
    try { await cleanup(); }
    catch (error) {
      sample.failures.push({ cleanupError: String(error) }); sample.outcome = 'failed'; errors.push(error);
    }
  }
  sample.finishedAt = new Date().toISOString();
  try {
    await writeFile(path, JSON.stringify(sample, null, 2) + '\n');
  } catch (error) {
    sample.failures.push({ evidenceWriteError: String(error) }); sample.outcome = 'failed'; errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Operating sample failed during operation or finalization.', { cause: errors[0] });
}
