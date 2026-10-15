import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { preparePromptDraft } from '@orchardworks/agent-remote-web/react';
import { inspectImageDraft, readImageDraft, type ImageDraftBinding, type ImageDraftStorageHandle, type ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import { SessionSuccessionDialog } from '../components/SessionSuccessionDialog.js';
import type { DraftBinding } from '../draft-store.js';
import { SessionViewOperationsContext, type SessionOperationBinding } from '../session-view-operations.js';
import { readPrefixEdit, retainPrefixEdit, savePrefixEdit, finishPrefixEdit, type PrefixEditIntent } from '../prompt-edit-succession.js';

/** One initiating view retains its original operation independently of current navigation. */
export function usePromptEditOperation(binding: SessionOperationBinding | undefined, text: DraftBinding | undefined,
  image: ImageDraftBinding | undefined, viewId: string | undefined, explicitRecipient?: ImageDraftRecipient) {
  const environment = useContext(SessionViewOperationsContext);
  const scope = environment?.storageScope;
  const key = viewId ?? text?.key;
  const identity = JSON.stringify([scope, key]);
  const accessRef = useRef({ identity, transport: environment?.transport, enabled: environment?.enabled, active: true });
  if (accessRef.current.identity !== identity || accessRef.current.transport !== environment?.transport || accessRef.current.enabled !== environment?.enabled) {
    accessRef.current.active = false; accessRef.current = { identity, transport: environment?.transport, enabled: environment?.enabled, active: true };
  }
  const access = accessRef.current;
  const restored = useMemo(() => {
    try { return { intent: scope && key ? readPrefixEdit(scope, key) : undefined, error: undefined as string | undefined }; }
    catch (error) { return { intent: undefined, error: error instanceof Error ? error.message : 'The original prompt edit could not be read.' }; }
  }, [identity]);
  const [selected, setSelection] = useState<{ identity: string; entry: ProjectedTimelineEntry; binding: SessionOperationBinding; access: typeof access; recipient?: ImageDraftRecipient; text: DraftBinding; image: ImageDraftBinding }>();
  const selection = selected?.identity === identity ? selected : undefined;
  const [pending, setPending] = useState<{ identity: string; intent: PrefixEditIntent }>();
  const [finished, setFinished] = useState<string>();
  const intent = (pending?.identity === identity ? pending.intent : undefined) ?? (restored.intent?.operation.operationId === finished ? undefined : restored.intent);
  const preparing = useRef<PrefixEditIntent>();
  const baselineHandle = useRef<{ identity: string; operationId: string; text: DraftBinding; image: ImageDraftStorageHandle; textRevision: number; imageRevision: number }>();
  const appliedHandle = useRef<{ operationId: string; text: DraftBinding; image: ImageDraftStorageHandle; textRevision: number; imageRevision: number }>();
  // These revisions belong to this mount; persisted revision numbers cannot identify a new editor.
  const resumedOwner = useMemo(() => restored.intent && text && image ? {
    operationId: restored.intent.operation.operationId, text, image, textRevision: text.store.snapshot(text.key).revision,
  } : undefined, [identity]);
  const recovery = useRef<Promise<void>>();
  const [recoveredOwner, setRecoveredOwner] = useState<string>();
  const recoveringDraft = !!intent && intent.operation.operationId === resumedOwner?.operationId && recoveredOwner !== identity;
  const resumedSource = useRef<{ operationId: string; binding: SessionOperationBinding; recipient?: ImageDraftRecipient }>();
  if (intent && !selection && resumedSource.current?.operationId !== intent.operation.operationId && binding?.scope?.isCurrent()
    && binding.source.agentId === intent.source.agentId && binding.source.nativeSessionId === intent.source.nativeSessionId) {
    resumedSource.current = { operationId: intent.operation.operationId, binding, recipient: explicitRecipient };
  }
  const mounted = useRef(false);
  const latest = useRef({ identity, environment, binding, text, image, explicitRecipient });
  latest.current = { identity, environment, binding, text, image, explicitRecipient };
  useLayoutEffect(() => { mounted.current = true; preparing.current = undefined; return () => { mounted.current = false; }; }, [identity]);
  useEffect(() => {
    if (!resumedOwner) return;
    let active = true;
    recovery.current = (async () => {
      const handle = await inspectImageDraft(resumedOwner.image);
      if (!active || !handle.replace) return;
      baselineHandle.current = { identity, operationId: resumedOwner.operationId, text: resumedOwner.text, image: handle,
        textRevision: resumedOwner.textRevision, imageRevision: handle.snapshot().revision };
    })().finally(() => { if (active) setRecoveredOwner(identity); });
    return () => { active = false; };
  }, [identity]);
  const source = intent?.source ?? selection?.binding.source;
  const directory = useMemo(() => source && environment?.directory(source), [environment?.storageScope, environment?.transport, source?.hostId, source?.providerId, source?.nativeSessionId]);
  const preparation = useMemo(() => intent?.operation.preparation ?? (selection?.entry.item.type === 'user_message' && selection.entry.item.messageId && selection.entry.turnId
    ? { kind: 'native_prefix' as const, turnId: selection.entry.turnId, messageId: selection.entry.item.messageId } : undefined), [intent?.operation, selection]);
  function assertAccess() {
    if (!(selection?.access ?? access).active || !access.active || !mounted.current || latest.current.identity !== identity || !environment?.enabled || !latest.current.environment?.enabled
      || latest.current.environment.transport !== environment.transport) throw new Error('The account or view connection changed. Reopen the original prompt edit.');
  }
  function assertSource() {
    assertAccess();
    const resumed = resumedSource.current?.operationId === intent?.operation.operationId ? resumedSource.current : undefined;
    const selected = selection?.binding ?? resumed?.binding, current = selected?.scope;
    const state = current?.replica.getState(), agent = state?.agent;
    if (!source || !current?.isCurrent() || current.transport !== environment?.transport || agent?.id !== source.agentId
      || agent.providerId !== source.providerId || agent.runtimeInfo.sessionId !== source.nativeSessionId || selected?.historical
      || selection && (latest.current.text?.store !== selection.text.store || latest.current.text?.key !== selection.text.key
        || JSON.stringify(latest.current.image) !== JSON.stringify(selection.image) || latest.current.explicitRecipient !== selection.recipient)
      || !selection && (!resumedOwner || latest.current.text?.store !== resumedOwner.text.store || latest.current.text?.key !== intent?.owner.textKey
        || JSON.stringify(latest.current.image) !== JSON.stringify(intent?.owner.image) || latest.current.explicitRecipient !== resumed?.recipient)
      || source.parentNativeSessionId || !current.client.getSessionState().synchronized || current.client.getSessionState().readOnly
      || (selection?.recipient ?? resumed?.recipient) && !(selection?.recipient ?? resumed?.recipient)!.isCurrent()) throw new Error('The original prompt view is no longer ready for editing.');
  }
  const editPrompt = environment && binding?.scope && text && image && key && !binding.historical && !binding.source.parentNativeSessionId
    ? async (entry: ProjectedTimelineEntry) => {
      if (intent || preparing.current) throw new Error('Resolve the original prompt edit before starting another.');
      if (restored.error) throw new Error(restored.error);
      if (entry.item.type !== 'user_message' || !entry.item.messageId || !entry.turnId) throw new Error('This prompt has no native prefix boundary.');
      const messageId = entry.item.messageId;
      const actual = binding.scope!.replica.getState().timeline.entries.find(candidate => candidate.turnId === entry.turnId
        && candidate.item.type === 'user_message' && candidate.item.messageId === messageId && candidate.seqStart === entry.seqStart);
      if (!binding.scope!.isCurrent() || !actual) throw new Error('The selected prompt no longer belongs to this view.');
      setSelection({ identity, entry: actual, binding, access, recipient: explicitRecipient, text, image });
    } : undefined;
  const notice = source && directory && environment && scope && key && preparation ? <SessionSuccessionDialog key={identity}
    source={source} directory={directory} preparation={preparation} autoPrepare resume={intent?.operation} resumeCancellation={intent?.cancelRequested}
    assertAccess={assertAccess} assertSource={assertSource}
    onPreparing={async operation => {
      assertSource();
      if (!selection || !text || !image || selection.entry.item.type !== 'user_message') throw new Error('The selected prompt is unavailable.');
      const handle = await inspectImageDraft(image);
      assertSource();
      const imageSnapshot = await handle.flush(handle.snapshot().revision, () => selection.binding.scope!.isCurrent());
      assertSource();
      if (imageSnapshot.status !== 'ready') throw new Error('The current image draft is not ready.');
      const textSnapshot = text.store.snapshot(text.key);
      baselineHandle.current = { identity, operationId: operation.operationId, text, image: handle, textRevision: textSnapshot.revision, imageRevision: imageSnapshot.revision };
      const current = selection.binding.scope!, state = current.replica.getState();
      const draft = await preparePromptDraft(selection.entry.item, { scopeKey: JSON.stringify([current.agentId, state.timeline.epoch]),
        bindings: selection.entry.resources, resources: state.resources,
        resolveResource: current.client.resolveResource.bind(current.client), requestResource: async resource => (await current.client.requestResource(resource.resourceId)).payload.state });
      assertSource();
      const ownerCurrent = () => {
        try { assertSource(); } catch { return false; }
        return current.isCurrent() && text.store.snapshot(text.key).revision === textSnapshot.revision
          && handle.snapshot().revision === imageSnapshot.revision && handle.snapshot().status === 'ready';
      };
      const retained = await retainPrefixEdit(scope, key, { version: 1, source, operation,
        owner: { textKey: text.key, image }, baseline: { text: textSnapshot.text, textRevision: textSnapshot.revision,
          imageRevision: imageSnapshot.revision, imageParts: JSON.stringify(imageSnapshot.draft?.parts ?? []) } }, draft, ownerCurrent);
      assertSource(); preparing.current = retained;
    }}
    onIntent={(operation, cancelRequested) => {
      const saved = preparing.current ?? intent;
      if (!saved || saved.operation.operationId !== operation.operationId) throw new Error('The original prompt edit identity changed.');
      const next = { ...saved, cancelRequested }; savePrefixEdit(scope, key, next); preparing.current = next; setPending({ identity, intent: next });
    }}
    onSettled={async result => {
      assertAccess();
      let saved = readPrefixEdit(scope, key);
      if (!saved || saved.operation.operationId !== result.record.operationId) throw new Error('The original prompt edit identity changed.');
      await recovery.current;
      assertAccess();
      await environment.refreshSettled(result, source);
      assertAccess();
      if (result.record.phase !== 'committed' || saved.restored) return;
      const target = result.record.to;
      const deadline = Date.now() + 15000;
      while (target && Date.now() < deadline && (!latest.current.binding?.scope?.isCurrent()
        || latest.current.binding.source.providerId !== target.providerId || latest.current.binding.source.nativeSessionId !== target.nativeSessionId
        || latest.current.explicitRecipient && !latest.current.explicitRecipient.isCurrent())) {
        await new Promise(resolve => setTimeout(resolve, 25)); assertAccess();
      }
      const current = latest.current.binding, owner = latest.current.text, imageOwner = latest.current.image;
      if (!target || !current?.scope?.isCurrent() || current.source.providerId !== target.providerId || current.source.nativeSessionId !== target.nativeSessionId
        || !owner || !imageOwner || owner.key !== saved.owner.textKey || JSON.stringify(imageOwner) !== JSON.stringify(saved.owner.image)
        || latest.current.explicitRecipient && !latest.current.explicitRecipient.isCurrent()) throw new Error('The committed prompt is retained. Wait for its exact target view, then retry refresh.');
      const targetScope = current.scope, recipient = latest.current.explicitRecipient;
      const targetCurrent = () => {
        try { assertAccess(); } catch { return false; }
        return targetScope.isCurrent() && latest.current.text?.store === owner.store && latest.current.text.key === owner.key
          && JSON.stringify(latest.current.image) === JSON.stringify(imageOwner)
          && latest.current.explicitRecipient === recipient && (!recipient || recipient.isCurrent());
      };
      const imageHandle = await inspectImageDraft(imageOwner);
      assertAccess();
      const snapshot = await imageHandle.flush(imageHandle.snapshot().revision, targetCurrent);
      const textSnapshot = owner.store.snapshot(owner.key), original = baselineHandle.current?.identity === identity
        && baselineHandle.current.operationId === saved.operation.operationId ? baselineHandle.current : undefined;
      const unchanged = () => targetCurrent()
        && owner.store.snapshot(owner.key).revision === textSnapshot.revision && imageHandle.snapshot().revision === snapshot.revision;
      const applied = appliedHandle.current?.operationId === saved.operation.operationId ? appliedHandle.current : undefined;
      const alreadyApplied = !!saved.restoration && textSnapshot.text === saved.restoration.text
        && JSON.stringify(snapshot.draft?.parts ?? []) === saved.restoration.imageParts;
      const previous = applied ?? original;
      const ownRevisions = !!previous && previous.text.store === owner.store && previous.text.key === owner.key && previous.image === imageHandle
        && previous.textRevision === textSnapshot.revision && previous.imageRevision === snapshot.revision;
      if (snapshot.status !== 'ready' || !ownRevisions || !alreadyApplied && (textSnapshot.text !== saved.baseline.text || JSON.stringify(snapshot.draft?.parts ?? []) !== saved.baseline.imageParts
        || !original || original.text.store.snapshot(original.text.key).revision !== original.textRevision || original.image.snapshot().revision !== original.imageRevision)) {
        throw new Error('A newer draft is preserved. The original prompt edit remains available for recovery.');
      }
      const draft = await readImageDraft(saved.prompt.key);
      assertAccess();
      if (!draft || !unchanged()) throw new Error('The selected prompt or its target owner is unavailable.');
      if (!alreadyApplied && imageHandle.replace) {
        saved = { ...saved, restoration: { text: draft.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(''), imageParts: JSON.stringify(draft.parts) } };
        savePrefixEdit(scope, key, saved);
        let replacementTextRevision: number | undefined;
        const replacement = imageHandle.replace(snapshot.revision, draft, () => {
          assertAccess();
          const observed = owner.store.snapshot(owner.key);
          if (replacementTextRevision === undefined && observed.revision !== textSnapshot.revision) {
            if (observed.text !== draft.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')) return false;
            replacementTextRevision = observed.revision;
          }
          return targetCurrent()
            && observed.revision === (replacementTextRevision ?? textSnapshot.revision);
        });
        appliedHandle.current = { operationId: saved.operation.operationId, text: owner, image: imageHandle,
          textRevision: owner.store.snapshot(owner.key).revision, imageRevision: snapshot.revision + 1 };
        const replaced = await replacement;
        if (replaced.status !== 'ready' || replaced.savedRevision !== replaced.revision) throw new Error('The selected prompt could not be restored without replacing a newer draft.');
      } else if (!alreadyApplied) {
        throw new Error('The target image editor is not ready. Retry refresh.');
      }
      const revision = owner.store.snapshot(owner.key).revision;
      const retained = await owner.store.flushCurrent(owner.key, revision, targetCurrent);
      if (retained.status !== 'saved') throw new Error('The restored prompt is not yet retained. Keep this view open.');
      savePrefixEdit(scope, key, { ...saved, restored: true });
    }}
    onClose={retain => {
      if (retain) return;
      if (intent) { finishPrefixEdit(scope, key, intent.operation.operationId); setFinished(intent.operation.operationId); }
      preparing.current = undefined; setPending(undefined); setSelection(undefined);
    }} /> : restored.error ? <p role="alert">{restored.error}</p> : undefined;
  return { editPrompt, notice, recoveringDraft };
}
