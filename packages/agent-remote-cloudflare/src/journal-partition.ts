import { DurableObject } from 'cloudflare:workers';
import {
  createHostJournals, JOURNAL_PARTITION_CACHE, JOURNAL_PARTITION_LIMITS, serveJournalPartition,
  type HostJournalsOptions, type JournalPartitionApi,
} from '@orchardworks/agent-remote-hosted';
import { SqlJournalStore, type JournalSqlDatabase } from '@orchardworks/agent-remote-journal-sqlite';

import { durableObjectJournalDatabase } from './journal-sql-database.js';

export interface JournalPartitionTuning extends Pick<HostJournalsOptions, 'cache' | 'limits' | 'retention'> {
  /** The size above which a page reply is answered again with fewer entries. */
  replyMaxBytes?: number;
}

/**
 * The journals of one Host: the hosted journal service over a SQLite store in this object's own storage. Only `primary`
 * calls it, through Durable Object RPC; it has no `fetch` and does no authorization. One object per Host, named by the Host id.
 */
export class JournalPartition extends DurableObject<unknown> implements JournalPartitionApi {
  private readonly api: JournalPartitionApi;

  constructor(context: DurableObjectState, env: unknown) {
    super(context, env);
    const tuning = this.tuning();
    const journals = createHostJournals({
      store: new SqlJournalStore(this.database(context.storage)), now: Date.now,
      cache: tuning.cache, limits: tuning.limits, retention: tuning.retention,
    });
    this.api = serveJournalPartition(journals, tuning.replyMaxBytes === undefined ? {} : { replyMaxBytes: tuning.replyMaxBytes });
  }

  /** The SQL port of the store. */
  protected database(storage: DurableObjectStorage): JournalSqlDatabase {
    return durableObjectJournalDatabase(storage);
  }

  /** The bounds of this object; a Durable Object has 128 MB of memory. */
  protected tuning(): JournalPartitionTuning {
    return { cache: JOURNAL_PARTITION_CACHE, limits: JOURNAL_PARTITION_LIMITS };
  }

  open(...args: Parameters<JournalPartitionApi['open']>) { return this.api.open(...args); }
  indexPage(...args: Parameters<JournalPartitionApi['indexPage']>) { return this.api.indexPage(...args); }
  publish(...args: Parameters<JournalPartitionApi['publish']>) { return this.api.publish(...args); }
  fill(...args: Parameters<JournalPartitionApi['fill']>) { return this.api.fill(...args); }
  page(...args: Parameters<JournalPartitionApi['page']>) { return this.api.page(...args); }
  status(...args: Parameters<JournalPartitionApi['status']>) { return this.api.status(...args); }
  servedSessions(...args: Parameters<JournalPartitionApi['servedSessions']>) { return this.api.servedSessions(...args); }
  deleteHost(...args: Parameters<JournalPartitionApi['deleteHost']>) { return this.api.deleteHost(...args); }
}
