/** Compatibility names for the existing SQLite record format and its storage tests. */
export {
  HOSTED_SNAPSHOT_FORMAT as SQL_SNAPSHOT_FORMAT,
  HOSTED_RECORD_FORMAT as SQL_RECORD_FORMAT,
  HOSTED_CHUNK_BYTES as SQL_CHUNK_BYTES,
  HOSTED_RECORD_KINDS as SQL_RECORD_KINDS,
  encodeHostedSnapshot as encodeSqlSnapshot,
  decodeHostedSnapshot as decodeSqlSnapshot,
  preflightHostedSnapshot as preflightSqlSnapshot,
  quoteHostedRecord as quoteSqlRecord,
  type HostedRecordKind as SqlRecordKind,
  type HostedManifest as SqlManifest,
  type HostedChunk as SqlChunk,
  type HostedEncodedRecord as SqlEncodedRecord,
  type HostedRecordCost as SqlRecordCost,
  type HostedSnapshot as SqlSnapshot,
} from '@orchardworks/agent-remote-hosted';
