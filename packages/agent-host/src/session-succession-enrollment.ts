import { isRelationChangeReservation, relationChangeKey, type RelationChangeReservation } from '@orchardworks/agent-remote-protocol';
import { sourceParticipantId } from './source-participant.js';
import { realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import { successionAuthorityKey, successionFreezeKey, isSuccessionAssociationFreeze, nativeSessionRefKey, type NativeSessionRef, type TrustedSuccessionContext, type SuccessionParticipant, type SuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';
import type { AgentRemoteHttpResult, RemoteHostControlRequest } from '@orchardworks/agent-remote-relay';
import type { AgentHostProviderRegistration } from './host.js';
import type { TpmRecord } from './tpm-store.js';
import type { AssociationRecovery } from './session-succession-store.js';
import type { SessionSuccessionService } from './session-succession-service.js';
export type EnrollmentMutation = <T>(scope: string, operationId: string, kind: string, targets: readonly NativeSessionRef[], parameters: unknown,
  dispatch: () => Promise<T>, validate?: () => Promise<void>) => Promise<T>;
const key = nativeSessionRefKey;
const json = (status: number, value: unknown): AgentRemoteHttpResult => ({ status, body: JSON.stringify(value) });

/** Only the registered uplink callback owns this endpoint; its JSON body is never authority. */
export class SessionSuccessionEnrollment {
  constructor(private readonly service: SessionSuccessionService, private readonly controllerId: string,
    private readonly registrations: () => AgentHostProviderRegistration[], private readonly works: () => TpmRecord[],
    private readonly authorize: (source: NativeSessionRef) => Promise<void>, private readonly admitMutation: EnrollmentMutation) {}

  async control(request: RemoteHostControlRequest, context: TrustedSuccessionContext): Promise<AgentRemoteHttpResult> {
    try {
      await this.service.ready;
      if (request.method !== 'POST' || context.installationId !== this.controllerId) throw new Error('Succession Controller authority does not match.');
      const input = JSON.parse(request.body ?? '{}');
      if (typeof input.action === 'string' && input.action.startsWith('relation_')) {
        if (Object.keys(input).some(name => !['action', 'reservation', 'associationRevision'].includes(name)) || !isRelationChangeReservation(input.reservation)) throw new Error('A strict relation reservation is required.');
        const reservation: RelationChangeReservation = input.reservation;
        if (reservation.controllerId !== this.controllerId || successionAuthorityKey(reservation.authority) !== successionAuthorityKey(context.authority)) throw new Error('Relation authority does not match this connection.');
        const saved = this.service.store.relationChange(reservation.operationId);
        if (saved && relationChangeKey(saved.reservation) !== relationChangeKey(reservation)) throw new Error('Relation operation identity conflict.');
        const authorize = async () => { for (const ref of [reservation.readerRef, reservation.sourceRef, reservation.current]) await this.authorize(ref); };
        if (input.action === 'relation_status') { await authorize(); return json(200, { receipt: saved ?? null }); }
        if (!['relation_reserve', 'relation_apply', 'relation_release'].includes(input.action)) throw new Error('Invalid relation action.');
        let generation = this.service.store.generation;
        const validate = async () => {
          generation = this.service.store.generation;
          await authorize();
          if (input.action === 'relation_reserve' && !saved || input.action === 'relation_apply' && saved?.phase === 'reserved') {
            const grants = [];
            for (const { directory } of this.registrations()) {
              if (!directory.sourceReferences) throw new Error('A provider cannot certify its complete durable source grants.');
              for (const grant of await directory.sourceReferences()) grants.push({ ...grant,
                readerRef: { controllerId: this.controllerId, providerId: directory.providerId, nativeSessionId: grant.nativeSessionId },
                sourceRef: { controllerId: this.controllerId, providerId: directory.providerId, nativeSessionId: grant.sourceNativeSessionId } });
            }
            this.service.bindings(reservation.sourceRef.providerId).sourceParticipants(reservation.roleId,
              reservation.relations.map(row => ({ ...row, relationId: sourceParticipantId(row.readerRef, row.relationId), nativeSessionId: row.readerRef.nativeSessionId, sourceNativeSessionId: row.sourceRef.nativeSessionId })), grants);
            await authorize();
          }
        };
        const change = async () => {
          if (input.action === 'relation_reserve') return this.service.store.reserveRelationChange(reservation, generation);
          if (input.action === 'relation_apply') return this.service.store.applyRelationChange(reservation, generation);
          if (!Number.isSafeInteger(input.associationRevision)) throw new Error('An exact applied revision is required.');
          return this.service.store.releaseRelationChange(reservation, input.associationRevision);
        };
        const receipt = input.action === 'relation_reserve' && !saved
          // The readable store owns replay; a trusted metadata-only observation may
          // revalidate after a pre-effect rejection without changing durable identity.
          ? await this.admitMutation(`host:relation:${successionAuthorityKey(context.authority)}:admission-attempt:${randomUUID()}`, reservation.operationId, 'relation_reserve',
            [reservation.readerRef, reservation.sourceRef, reservation.current], { reservation }, change, validate)
          : await (async () => { await validate(); return change(); })();
        return json(200, { receipt });
      }
      if (input.action === 'source-result') {
        if (!request.operationScope || Object.keys(input).some(name => !['action','providerId','operationId','sourceNativeSessionId','parameters'].includes(name)) || typeof input.operationId !== 'string' || typeof input.providerId !== 'string' || typeof input.sourceNativeSessionId !== 'string') throw new Error('Invalid source recovery identity.');
        const source = {controllerId:this.controllerId,providerId:input.providerId,nativeSessionId:input.sourceNativeSessionId};
        await this.authorize(source);
        const result = await this.sourceResult(request.operationScope, input.operationId, source, input.parameters);
        if (!result) throw new Error('Source creation has no durable result witness; it remains unknown.');
        return json(200, {source:result.source,reader:result.reader,operationId:result.operationId});
      }
      if (input.action === 'describe') {
        if (Object.keys(input).some(name => !['action', 'providerId', 'nativeSessionId'].includes(name)) || typeof input.providerId !== 'string' || typeof input.nativeSessionId !== 'string') throw new Error('Invalid source selection.');
        const source = { controllerId: this.controllerId, providerId: input.providerId, nativeSessionId: input.nativeSessionId };
        await this.authorize(source);
        const registration = this.registrations().find(item => item.directory.providerId === source.providerId);
        const cwd = await registration?.directory.sessionWorkspace?.(source.nativeSessionId);
        if (!cwd) throw new Error('The actual source workspace is unavailable.');
        const role = await this.service.store.ensureRole(source, await realpath(cwd));
        const state = this.service.store.read(role.id);
        if (state.associationAuthority && successionAuthorityKey(state.associationAuthority) !== successionAuthorityKey(context.authority)) throw new Error('Primary role belongs to another association authority.');
        return json(200, { role, lineage: this.service.store.lineage(state), relationUpdates: 1, associationRevision: state.associationRevision, sourceParticipants: state.participants.filter(row => row.kind !== 'tpm').map(row => ({ relationId: row.relationId, kind: row.kind, readerRef: row.after })) });
      }
      if (Object.keys(input).some(name => !['action', 'freeze'].includes(name)) || !isSuccessionAssociationFreeze(input.freeze)) throw new Error('A complete frozen association receipt is required.');
      const freeze: SuccessionAssociationFreeze = input.freeze;
      if (freeze.controllerId !== this.controllerId || successionAuthorityKey(freeze.authority) !== successionAuthorityKey(context.authority)) throw new Error('Frozen association authority does not match this connection.');
      await this.authorize(freeze.request.from);
      const state = this.service.store.read(freeze.request.roleId);
      const saved = state.enrollments?.find(receipt => receipt.request.operationId === freeze.request.operationId);
      if (saved && successionFreezeKey(saved) !== successionFreezeKey(freeze)) throw new Error('Frozen association receipt changed.');
      if (input.action === 'prepare') {
        let record;
        if (saved) record = this.service.coordinator.status(freeze.request.operationId);
        else {
          const generation = this.service.store.generation;
          const grants = [];
          for (const { directory } of this.registrations()) {
            if (!directory.sourceReferences) throw new Error('A provider cannot certify its complete durable source grants.');
            for (const grant of await directory.sourceReferences()) grants.push({ ...grant,
              readerRef: { controllerId: this.controllerId, providerId: directory.providerId, nativeSessionId: grant.nativeSessionId },
              sourceRef: { controllerId: this.controllerId, providerId: directory.providerId, nativeSessionId: grant.sourceNativeSessionId } });
          }
          const participants: SuccessionParticipant[] = this.service.bindings(freeze.request.from.providerId).sourceParticipants(state.role.id,
            freeze.relations.map(relation => ({ ...relation, relationId: sourceParticipantId(relation.readerRef, relation.relationId), nativeSessionId: relation.readerRef.nativeSessionId, sourceNativeSessionId: relation.sourceRef.nativeSessionId })), grants)
            .filter(participant => participant.kind !== 'tpm');
          const lineage = new Set(freeze.lineage.map(key));
          for (const item of this.works()) {
            const work = item.work;
            const source = work.mainBinding?.kind === 'fixed' ? work.mainBinding.source : work.mainSessionRef
              ?? { controllerId: this.controllerId, providerId: work.providerId, nativeSessionId: work.mainNativeSessionId };
            if (!(work.mainBinding?.kind === 'primary_role' && work.mainBinding.roleId === state.role.id) && !lineage.has(key(source))) continue;
            if (item.creation !== 'accepted' || !work.tpmNativeSessionId) throw new Error('TPM association creation is unresolved.');
            const target = { controllerId: this.controllerId, providerId: work.providerId, nativeSessionId: work.tpmNativeSessionId };
            participants.push({ relationId: `tpm:${work.id}`, kind: 'tpm', before: target, after: target } as SuccessionParticipant);
          }
          record = await this.service.coordinator.prepareEnrolled(freeze, participants, generation);
        }
        return json(200, { record, role: this.service.store.read(state.role.id).role, freeze });
      }
      if (!saved && input.action === 'cancel') {
        const record = await this.service.store.cancelUnenrolled(freeze);
        return json(200, { record, role: this.service.store.read(state.role.id).role, freeze });
      }
      if (!saved) throw new Error('Frozen association receipt is not enrolled.');
      let record = this.service.coordinator.status(freeze.request.operationId);
      if (input.action === 'commit') record = await this.service.commit(record.operationId, freeze.request.expectedRevision);
      else if (input.action === 'cancel') record = await this.service.coordinator.cancel(record.operationId);
      else if (input.action === 'reconcile') record = await this.service.coordinator.reconcileReady(record.operationId);
      else if (input.action === 'release') await this.service.store.releaseEnrollment(freeze);
      else if (input.action !== 'status') throw new Error('Invalid enrollment action.');
      return json(200, { record, role: this.service.store.read(state.role.id).role, freeze });
    } catch (error) { return json(409, { code: 'succession_enrollment_failed', error: error instanceof Error ? error.message : 'Succession enrollment failed.' }); }
  }

  private sourceFingerprint(source: NativeSessionRef, parameters: unknown): string {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.entries(parameters).some(([name,value]) => !['sourceNativeSessionId','cwd','workspaceId','model','reasoningEffort','planning'].includes(name) || !['string','boolean'].includes(typeof value))) throw new Error('Invalid source creation parameters.');
    return createHash('sha256').update(JSON.stringify([key(source),Object.entries(parameters).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
  }
  async sourceResult(scope: string, operationId: string, source: NativeSessionRef, parameters: unknown) {
    await this.service.ready;
    const id=createHash('sha256').update(JSON.stringify([scope,operationId])).digest('hex');
    const result=this.service.store.sourceResult(id,this.sourceFingerprint(source,parameters));
    if (!result) return undefined;
    const directory=this.registrations().find(item=>item.directory.providerId===source.providerId)?.directory;
    if (!(await directory?.sourceReferences?.())?.some(grant=>grant.nativeSessionId===result.reader.nativeSessionId && grant.sourceNativeSessionId===source.nativeSessionId)) throw new Error('Persisted source creation no longer has its durable native grant.');
    return result;
  }
  async sourceMutation(scope: string, operationId: string, source: NativeSessionRef, parameters: unknown, dispatch: () => Promise<string>, verify: (nativeId:string)=>Promise<boolean>): Promise<string> {
    const previous=await this.sourceResult(scope,operationId,source,parameters);
    if (previous) return previous.reader.nativeSessionId;
    this.service.coordinator.assertAdmission(source);
    const id=createHash('sha256').update(JSON.stringify([scope,operationId])).digest('hex'),fingerprint=this.sourceFingerprint(source,parameters);
    await this.service.store.admitAssociation(id,fingerprint,source,true);
    let nativeId:string;
    try { nativeId=await dispatch(); }
    catch(error) {if(error instanceof AgentOperationRejectedError)await this.service.store.settleAssociation(id,fingerprint);throw error;}
    if(!await verify(nativeId))throw new Error('Durable source association evidence is unavailable; admission remains unresolved.');
    await this.service.store.completeSourceAssociation({id,fingerprint,scope,operationId,source,reader:{...source,nativeSessionId:nativeId}});
    return nativeId;
  }
  async tpmSource(source: NativeSessionRef): Promise<NativeSessionRef> {
    await this.service.ready;
    return this.service.store.all().find(item => this.service.store.lineage(item).some(ref => key(ref) === key(source)))?.role.current ?? source;
  }
  async tpmMutation<T>(scope: string, operationId: string, source: NativeSessionRef, parameters: unknown, dispatch: () => Promise<T>, verify: (result: T) => Promise<boolean>): Promise<T> {
    return this.mutation(scope, operationId, await this.tpmSource(source), parameters, dispatch, verify, false,
      { createKey: JSON.stringify([scope, operationId]), createFingerprint: createHash('sha256').update(JSON.stringify(parameters)).digest('hex') });
  }
  async recoverTpm(record: TpmRecord): Promise<void> {
    if (record.creation !== 'accepted' || !record.work.tpmNativeSessionId) throw new Error('TPM creation requires verified durable native evidence.');
    const source = record.work.mainSessionRef ?? { controllerId: this.controllerId, providerId: record.work.providerId, nativeSessionId: record.work.mainNativeSessionId };
    await this.service.store.settleRecoveredAssociation({ createKey: record.createKey, createFingerprint: record.createFingerprint }, source);
  }
  async recoverTpmAction(record: TpmRecord, scope: string, operationId: string, source: NativeSessionRef, parameters: unknown): Promise<void> {
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    if (record.creation !== 'accepted' || !record.work.tpmNativeSessionId || record.actions[hash([scope, operationId])]?.fingerprint !== hash(parameters)) throw new Error('TPM recovery action has no matching durable receipt.');
    await this.recoverTpm(record);
    await this.service.store.settleAssociation(hash([scope, operationId]), hash([source, parameters]), true);
  }
  async mutation<T>(scope: string, operationId: string, source: NativeSessionRef, parameters: unknown, dispatch: () => Promise<T>, verify: (result: T) => Promise<boolean>, sourceReader = false, recovery?: AssociationRecovery): Promise<T> {
    await this.service.ready;
    this.service.coordinator.assertAdmission(source);
    const id = createHash('sha256').update(JSON.stringify([scope, operationId])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([source, parameters])).digest('hex');
    await this.service.store.admitAssociation(id, fingerprint, source, sourceReader, recovery);
    let result: T;
    try { result = await dispatch(); }
    catch (error) {
      if (error instanceof AgentOperationRejectedError) await this.service.store.settleAssociation(id, fingerprint);
      throw error;
    }
    if (!await verify(result)) throw new Error('Durable source association evidence is unavailable; admission remains unresolved.');
    await this.service.store.settleAssociation(id, fingerprint);
    return result;
  }
}
