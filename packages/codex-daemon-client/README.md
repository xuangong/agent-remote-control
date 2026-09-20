# Codex daemon client

`@agent-remote-controller/codex-daemon-client` is a Node.js ESM client for Codex app-server JSON-RPC. It owns native transport, thread discovery, automatic reconnection and snapshot handoffs. Its only executable runtime dependency is `ws`; `@types/ws` and `@types/node` are delivered as transitive dependencies because the public transport declarations reference WebSocket and Node types. TypeScript consumers can check the public entrypoint with `strict: true` and `skipLibCheck: false` without installing `@types/ws` themselves. It has no Provider SDK, Remote, Relay, Host or browser dependency. Node.js 22 or newer is required.

## Attach an existing thread

The caller chooses the native socket, initialization identity and existing thread ID. Connecting the socket does not initialize the native protocol or attach a thread. The constructor accepts an open transport and binds its handlers. Call `initialize()` once for the initial connection; recovery initializes replacement connections automatically.

```js
import { CodexAppServerTransport } from '@agent-remote-controller/codex-daemon-client';
import { createNotebook } from './notebook.mjs';

const connect = () => CodexAppServerTransport.connectShared('/absolute/path/to/codex.sock');
const { client, notebook } = createNotebook(await connect(), connect);
try {
  await client.initialize();
  client.registerRoot('existing-native-thread-id');
  const attached = await client.request('thread/resume', {
    threadId: 'existing-native-thread-id', historyMode: 'paginated',
  });
  if (attached.thread.id !== 'existing-native-thread-id') throw new Error('Unexpected native thread');
  // The application can read the initial history here and seed its own projection.
  const initial = await client.request('thread/read', { threadId: attached.thread.id, includeTurns: true });
  notebook.documents.set(attached.thread.id, initial.thread.turns.flatMap(turn => turn.items).map(item => item.text ?? '').join(''));
  // Keep the client alive while the application uses this thread.
} finally {
  await client.dispose();
}
```

[`examples/notebook.mjs`](examples/notebook.mjs) is the runnable consumer used by the real Unix tests and the external packed-package test. It translates recovery into its own `replace` and `append` records. It imports only this package. Copy the example beside the code above. Its intentionally small text projection does not implement Codex approvals or every native item type.

For a newly created thread, call `thread/start` explicitly and register the returned ID. Registering a root records native identity for routing and recovery; it does not create or resume a thread. A client owns one root and its discovered descendants. Initial bootstrap and application state seeding are caller responsibilities; automatic recovery only restores a registered root. For applications that also require an atomic initial snapshot handoff, buffer initial notifications until their own initial history read is applied.

## Native callbacks and ordering

Pass callbacks to `new CodexDaemonClient({ transport, initialization, recovery, callbacks })`. All callbacks except `onRequest` are synchronous. Callbacks must not throw and must apply state before returning.

| Callback | Contract |
|---|---|
| `onNotification(method, params)` | Native notifications for known threads and initial root bootstrap. Unknown-child notifications wait for discovery. |
| `onSnapshot({ threadId, snapshot, notifications })` | Recovery replaces this thread's history, then applies the supplied notifications in order. These notifications are not delivered again through `onNotification`. Histories are validated against the requested native ID. |
| `onChild(child)` | Native child metadata, parent ID, history, discovery order and reconciled notifications. Controls and items absent from history survive; covered item deltas are removed. `historyState` is `available`, `uncertain`, or `unavailable`; `requiresRefresh` signals buffer overflow. An unavailable ephemeral child has metadata but cannot be opened. |
| `onChildOrigin(threadId, origin)` | Native spawn provenance discovered after the child's initial handoff. |
| `onRequest(method, params, id, context)` | Return the native response payload. Context contains the native thread ID, generation and cancellation signal. Native resolution, retired generations and disposal abort the signal and suppress late answers even if the consumer ignores cancellation. |
| `onInvalidated(reason, generation)` | Clear application interaction state for the retired generation before reconnecting. |
| `onConnection(info)` | Connection state changes, retry attempt, reason and next retry timestamp. `connected` describes recovery state, not initial initialization or attachment. |
| `onTermination(error)` | Final closure, including disposal or a transport failure without recovery configured. |
| `onTransport(transport, generation)` | Optional bridge for existing native adapters that retain transport references. Ordinary consumers use `client.request()`. |

Callbacks are optional: omitted notification/snapshot/child callbacks discard those handoffs. Omitting `onSnapshot` does not redirect buffered recovery notifications to `onNotification`. Omitting `onRequest` returns a JSON-RPC error for known native request methods; it never grants approval automatically. Unrecognized server request methods receive the transport's unsupported-method error. Interpret and validate native requests in the application before returning answers; there is no built-in UI or permission policy.

Recovery buffers notifications while it initializes, resumes the original root and reads every loaded thread. A text delta overlapping an authoritative item triggers a bounded reread, up to three reads. Snapshot cutoffs remove earlier timeline traffic; `serverRequest/resolved` survives every cutoff. After per-thread snapshot handoffs, unknown-child traffic and spawn provenance enter native discovery. Applying full native items should upsert by native item ID. The package never invents application Timeline or operation IDs.

## Lifecycle and outcomes

`client.request(method, params, timeoutMs?)` sends an RPC once and rejects while recovery is in progress or unavailable. Reconnect never calls `thread/start`, starts a turn, repeats an answer, or replays a setting write. A disconnected or timed-out mutation may already have executed: an error is not proof of non-delivery. The application owns mutation deduplication, user retry policy and outcome presentation. `CodexAppServerRpcError` preserves native code/data; `CodexServerRequestCanceled` suppresses obsolete server-request responses.

Recovery defaults are a jittered 500 ms initial delay, 30-second maximum delay, 10-second connection deadline and 30-second restoration deadline. Transient attempts are unlimited unless `maximumAttempts` is set. Permission failures, incompatible RPC methods and missing native threads stop automatic retries. A `CodexRestorationSemaphore(4)` is created per client by default; inject one shared `restorationScheduler` into multiple clients to cap their combined root restorations. Agent Remote Controller shares one four-slot scheduler across its Provider roots.

`hasThread`, `hasChild`, `waitForChild` and `inspectHistory` expose the native registry without an application session object. Native discovery never resumes an unavailable child just to make it writable. Observation retention and any subsequent refresh of an unobserved application view remain application responsibilities.

`dispose()` cancels recovery, invalidates requests and closes the transport. A delayed connection completing after cancellation is disposed. A shared transport never starts or stops the external daemon. A private transport created with `new CodexAppServerTransport(child)` owns and terminates that child process using the existing graceful shutdown behavior. Do not replace transport handlers after giving a transport to the client. Raw transport APIs remain available for low-level integrations and do not provide client recovery or mutation safety by themselves.

This package is Apache-2.0 licensed; see `LICENSE` and `NOTICE` for derived transport attribution. It can be built and packed locally with `pnpm build` and `pnpm pack`; no workspace package is needed at runtime.

## Check a packed artifact

From the source checkout, `node src/test-utils/check-packed-consumer.mjs /absolute/path/to/package.tgz` installs the archive into a fresh temporary directory outside the workspace. It compiles a separate TypeScript consumer with strict declaration checking, then runs the JavaScript notebook against a temporary Unix server. The fixture supplies normal Node types and TypeScript as development tools but no manual WebSocket type dependency. Installation, compilation and the native fixture each have bounded subprocess deadlines.

`readCodexHistoryPage(transport, threadId, { cursor?, metadata? })` reads up to ten native turns, newest first on the wire and chronological in the returned `thread.turns`. `historyCursor` identifies an older page. An explicit native method-not-found error retains compatibility with legacy full-history reads. Other errors are surfaced unchanged. `CodexDaemonClient` applications can opt into bounded recovery and child snapshots using `paginatedHistory: true`; snapshot callbacks then receive the same optional history cursor. The Controller enables this option and delegates older-page ingestion to its Provider/Relay layers.
