import {
  CodexAppServerTransport,
  CodexDaemonClient,
  CodexRestorationSemaphore,
  type CodexDaemonCallbacks,
} from '@agent-remote-controller/codex-daemon-client';

export function createDocumentClient(transport: CodexAppServerTransport, connect: () => Promise<CodexAppServerTransport>) {
  const documents = new Map<string, unknown>();
  const callbacks: CodexDaemonCallbacks = {
    onSnapshot: ({ threadId, snapshot, notifications }) => {
      documents.set(threadId, { snapshot, updates: notifications });
    },
    onRequest: async (_method, _params, requestId, { threadId, signal }) => {
      signal.throwIfAborted();
      return { requestId, document: threadId };
    },
  };
  const client = new CodexDaemonClient({
    transport,
    initialization: { clientInfo: { name: 'typed-documents', version: '1.0.0' } },
    recovery: { connect },
    restorationScheduler: new CodexRestorationSemaphore(2),
    callbacks,
  });
  return { client, documents };
}
