import { errorWords } from '@orchardworks/agent-client';
import { useTranslate } from './locale.js';
import { useEffect, useRef, useState } from 'react';
import type { AgentCommand } from '@orchardworks/agent-remote-protocol';

export function useAgentCommands(sessionKey: string, active: boolean, list?: () => Promise<AgentCommand[]>) {
  const t = useTranslate();
  const listRef = useRef(list);
  listRef.current = list;
  const [revision, refresh] = useState(0);
  const [directory, setDirectory] = useState<{ key: string; status: 'loading' | 'ready' | 'failed'; commands: AgentCommand[]; error?: string }>({ key: sessionKey, status: 'loading', commands: [] });
  useEffect(() => {
    if (!active) return;
    let current = true;
    setDirectory({ key: sessionKey, status: 'loading', commands: [] });
    const load = listRef.current;
    if (!load) {
      setDirectory({ key: sessionKey, status: 'ready', commands: [] });
      return;
    }
    void Promise.resolve().then(load).then((commands) => {
      if (current) setDirectory({ key: sessionKey, status: 'ready', commands });
    }, (error: unknown) => {
      if (current) setDirectory({ key: sessionKey, status: 'failed', commands: [], error: errorWords(error, t, 'composer.commandsFailed') });
    });
    return () => { current = false; };
  }, [sessionKey, active, revision]);
  return { ...(directory.key === sessionKey ? directory : { status: 'loading' as const, commands: [], error: undefined }), retry: () => refresh((value) => value + 1) };
}
