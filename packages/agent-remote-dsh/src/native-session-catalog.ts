import { SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session';
import { RemoteHostCatalogError, type RemoteSessionSummary } from './remote-host-catalog.js';

export interface NativeSessionCatalogServices {
  get?(name: 'sessionProjectionCache'): NativeSessionCatalogServices['sessionProjectionCache'];
  readonly sessionQuery: {
    listSessions(signal?: AbortSignal): Promise<readonly { header: SessionHeader }[]>;
  };
  readonly sessionProjectionCache?: {
    cachedSnapshot(header: SessionHeader, inheritedEventCount: SessionLogOffset,
      keys: readonly ('title' | 'modelSelection' | 'sessionListMetadata')[]):
      { values: Readonly<Record<string, unknown>> } | undefined;
  };
}

const CATALOG_PROJECTIONS = ['title', 'modelSelection', 'sessionListMetadata'] as const;

export function createNativeSessionCatalog(
  services: Partial<NativeSessionCatalogServices>,
  liveRoots: () => readonly RemoteSessionSummary[],
): () => Promise<readonly RemoteSessionSummary[]> {
  return async () => {
    try {
      if (!services.sessionQuery) throw new Error('Native session query is unavailable.');
      const records = await services.sessionQuery.listSessions();
      const projectionCache = services.get
        ? services.get('sessionProjectionCache') : services.sessionProjectionCache;
      const summaries = new Map<string, RemoteSessionSummary>();
      for (const { header } of records) {
        if (header.origin === 'subagent' || header.cwd === undefined) continue;
        // A seeded header does not prove the inherited prefix required by cache identity.
        const values = header.isSeeded ? undefined
          : projectionCache?.cachedSnapshot(header, SessionLogOffset(0), CATALOG_PROJECTIONS)?.values;
        const metadata = record(values?.sessionListMetadata);
        const selection = record(values?.modelSelection);
        const model = nonEmptyString(record(selection?.lastUsed)?.model) ?? nonEmptyString(record(selection?.next)?.model);
        const lastPromptAt = metadata?.lastPromptAt;
        const updatedAt = typeof lastPromptAt === 'number' && Number.isFinite(lastPromptAt)
          ? Math.max(header.createdAt, lastPromptAt) : header.createdAt;
        summaries.set(String(header.id), {
          nativeSessionId: String(header.id), providerId: 'dsh',
          title: nonEmptyString(values?.title) ?? String(header.id), workspace: header.cwd,
          ...(model === undefined ? {} : { model }),
          createdAt: nativeTime(header.createdAt), updatedAt: nativeTime(updatedAt), state: 'idle',
        });
      }
      // Read live roots after the asynchronous listing so a concurrent resume wins.
      for (const summary of liveRoots()) summaries.set(summary.nativeSessionId, summary);
      return [...summaries.values()];
    } catch {
      throw new RemoteHostCatalogError('catalog_unavailable', 'Native Remote Session catalog is unavailable.');
    }
  };
}

function nativeTime(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid native session timestamp.');
  return new Date(value).toISOString();
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
