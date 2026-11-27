// A session link that asks for a bot: the question, the session's title, the terminal that may still hold it, and the bot made.
import { useEffect, useMemo, useState } from 'react';
import { errorWords } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';
import { SessionDirectoryClient } from '../kernel/directory-client.js';
import { SessionUseDialog, type SessionUsePhase } from '../features/sessions/SessionUseDialog.js';
import { applySessionUse, BOT_NAME_LIMIT, botBinding, existingBot, type SessionUsePorts, type SessionUseRequest } from '../features/sessions/session-use.js';
import { finishSessionUse } from '../features/sessions/session-use-page.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { AppInputs } from './types.js';

export function useSessionUse(scope: Pick<AppInputs & WorkbenchShellSlice & SessionSuccessionBindingSlice, 'baseUrl' | 'accessReady' | 'navigation' | 'windowWorkspace'>, opened: SessionUseRequest | undefined) {
  const t = useTranslate();
  const { baseUrl, accessReady, navigation, windowWorkspace } = scope;
  const [request, setRequest] = useState(opened);
  const [title, setTitle] = useState<string>();
  const [name, setName] = useState('');
  const [edited, setEdited] = useState(false);
  const [phase, setPhase] = useState<SessionUsePhase>('confirm');
  const [failure, setFailure] = useState<string>();
  const [owner, setOwner] = useState<NativeSessionOwner>();
  const directory = useMemo(() => request ? new SessionDirectoryClient(baseUrl, undefined, request.session.hostId) : undefined, [baseUrl, request]);

  const identity = request ? `${request.session.hostId}/${request.session.providerId}/${request.session.nativeSessionId}` : undefined;
  useEffect(() => {
    if (!request || !directory || !accessReady) return;
    const controller = new AbortController();
    setName(''); setEdited(false); setTitle(undefined); setPhase('confirm'); setFailure(undefined); setOwner(undefined);
    directory.nativeTitle(request.session.providerId, request.session.nativeSessionId, controller.signal).then(value => { if (value) setTitle(value); }, () => undefined);
    return () => controller.abort();
  }, [identity, accessReady]);

  // The bot starts with the name the link gave, else the session's own title, until the person types.
  const shownName = edited ? name : (request?.use.name ?? title ?? '').slice(0, BOT_NAME_LIMIT);
  function end() { finishSessionUse(); setRequest(undefined); }
  async function run(takeOver?: string) {
    if (!request || !directory) return;
    setPhase('working'); setFailure(undefined);
    const ports: SessionUsePorts = {
      attach: async generation => { await directory.attach(request.session.providerId, request.session.nativeSessionId, undefined, generation); },
      existingBot: binding => existingBot(windowWorkspace.groups, binding),
      createBot: (binding, name) => windowWorkspace.createBotGroup(binding, name),
      show: place => navigation.select({ kind: 'bot', groupId: place.groupId, viewId: place.viewId }),
    };
    try {
      const outcome = await applySessionUse(request, botBinding(request, shownName, title), ports, takeOver);
      if (outcome.kind === 'held') { setOwner(outcome.owner); setPhase('held'); return; }
      end();
    } catch (error) { setFailure(errorWords(error, t, 'sessions.use.failed')); setPhase('failed'); }
  }
  const sessionUseDialog = request && accessReady
    ? <SessionUseDialog title={title || shownName || request.session.nativeSessionId} providerId={request.session.providerId} name={shownName} phase={phase} failure={failure}
      onName={value => { setName(value); setEdited(true); }} onConfirm={() => void run()} onTakeOver={() => void run(owner?.generation)} onCancel={end} />
    : null;
  return { sessionUseDialog,
    /** A link scanned or pasted in the page: asks the same question. */
    startSessionUse: (next: SessionUseRequest) => { setRequest(next); } };
}

export type SessionUseSlice = ReturnType<typeof useSessionUse>;
