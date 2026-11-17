import { createHostJournals, JOURNAL_PARTITION_CACHE, JOURNAL_PARTITION_LIMITS, serveJournalPartition, type HostJournalsOptions, type JournalPartitionApi } from '@orchardworks/agent-relay-core';
import { overStructuredClone } from '@orchardworks/agent-relay-core/testing';
import { SqlJournalStore, type JournalSqlDatabase } from '@orchardworks/agent-remote-journal-sqlite';
import { openNodeJournalDatabase } from '@orchardworks/agent-remote-journal-sqlite/node';

/** The bounds a Durable Object partition takes, as its tuning gives them. */
export interface PartitionServerTuning extends Pick<HostJournalsOptions, 'cache' | 'limits' | 'retention'> { replyMaxBytes?: number }

/**
 * The partition server of one Host as a Node module: the composition of `JournalPartition` (the journal service over a
 * SQL store, served through `serveJournalPartition`) without the Durable Object shell, over a SQLite database in memory.
 * Its calls cross as structured clones, as they do over Durable Object RPC. `restart` builds the server again over the same
 * database, as a Durable Object does after it is evicted.
 */
export async function startPartitionServer(tuning: PartitionServerTuning = {}) {
  const database = await openNodeJournalDatabase(':memory:');
  const build = (db: JournalSqlDatabase): JournalPartitionApi => overStructuredClone(serveJournalPartition(
    createHostJournals({ store: new SqlJournalStore(db), cache: tuning.cache ?? JOURNAL_PARTITION_CACHE, limits: tuning.limits ?? JOURNAL_PARTITION_LIMITS, retention: tuning.retention }),
    tuning.replyMaxBytes === undefined ? {} : { replyMaxBytes: tuning.replyMaxBytes }));
  return { api: build(database), restart: () => build(database), close: () => database.close() };
}
