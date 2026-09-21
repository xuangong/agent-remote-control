import { CodexDaemonClient } from '@orchardworks/codex-daemon-client';

/** A consumer's own protocol: replace a document, append text, report connection health. */
export function createNotebook(transport, connect, recovery = {}) {
  const notebook = { documents: new Map(), messages: [], connection: 'connected' };
  const apply = (method, params) => {
    if (method === 'item/agentMessage/delta') {
      notebook.documents.set(params.threadId, (notebook.documents.get(params.threadId) ?? '') + params.delta);
      notebook.messages.push({ action: 'append', document: params.threadId, text: params.delta });
    }
  };
  const client = new CodexDaemonClient({
    transport,
    initialization: { clientInfo: { name: 'notebook', version: '1.0.0' }, capabilities: { experimentalApi: true } },
    recovery: { connect, settings: recovery },
    callbacks: {
      onNotification: apply,
      onSnapshot: ({ threadId, snapshot, notifications }) => {
        const text = snapshot.thread.turns.flatMap(turn => turn.items).map(item => item.text ?? '').join('');
        notebook.documents.set(threadId, text);
        notebook.messages.push({ action: 'replace', document: threadId, text });
        for (const { method, params } of notifications) apply(method, params);
      },
      onConnection: ({ state }) => { notebook.connection = state; },
    },
  });
  return { client, notebook };
}
