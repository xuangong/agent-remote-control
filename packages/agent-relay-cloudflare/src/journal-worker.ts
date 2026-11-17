export { JournalPartition } from './journal-partition.js';

/** The Worker that holds the journal partitions. Only `primary` reaches them, through Durable Object RPC; the Worker answers no request. */
export default {
  fetch(): Response { return new Response(null, { status: 404 }); },
};
