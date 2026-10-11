import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import {
  AGENT_NATIVE_EVIDENCE_REASONS as reasons, AGENT_NATIVE_EVIDENCE_LIMITS as limits,
  AgentOperationRejectedError, AgentNativeEvidenceOutcomeUnknownError,
  serializeAgentPreparedTextInput, parseAgentPreparedTextInput, serializeAgentInputMaterialization, parseAgentInputMaterialization,
  serializeAgentEmptyCreationResult,
  type AgentNativeAuthorityScope, type AgentPersistenceHandle, type AgentNativeEvidenceCode,
  type AgentNativeValidityToken, type AgentNativeReadiness, type AgentSessionNativeEvidence,
  type AgentPreparedTextInput, type AgentInputMaterialization, type AgentInputPart, type AgentMessageOptions,
} from '@orchardworks/agent-provider-sdk';

export const nativeHash = (text:string) => createHash('sha256').update(text,'utf8').digest('hex');
export function nativeCanonical(value:unknown):string {return JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);}
export function rejectNativeEvidence(code:AgentNativeEvidenceCode):never {throw new AgentOperationRejectedError(code,reasons[code]);}
const unknown=(code:AgentNativeEvidenceCode):AgentInputMaterialization => ({status:'unknown',code,reason:reasons[code]});
function same(a:unknown,b:unknown) {return nativeCanonical(a)===nativeCanonical(b);}
export function nativeIdentity(value:unknown):asserts value is string {if(typeof value!=='string'||!value||Buffer.byteLength(value)>limits.identityBytes||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) rejectNativeEvidence('native_evidence_invalid');}
function text(value:unknown,limit:number):asserts value is string {if(typeof value!=='string'||Buffer.byteLength(value)>limit||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) rejectNativeEvidence('native_evidence_invalid');}
function object(value:unknown,keys:string[],optional:string[]=[]):asserts value is Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))) rejectNativeEvidence('native_evidence_invalid');
  const fields=Object.getOwnPropertyDescriptors(value);
  if(Object.getOwnPropertySymbols(value).length||Object.values(fields).some(field=>!('value'in field)||!field.enumerable)||keys.some(key=>!Object.hasOwn(fields,key))||Object.keys(fields).some(key=>!keys.includes(key)&&!optional.includes(key))) rejectNativeEvidence('native_evidence_invalid');
}
export interface CopilotNativeSelections {model:string;reasoningEffort?:string;contextTier?:string;agent?:string;mode:'interactive'|'plan'|'autopilot';toolApproval?:'ask'|'allow';}
export interface CopilotEmptyDescriptor {version:1;kind:'copilot.empty';sessionId:string;cwd:string;authority:AgentNativeAuthorityScope;selections:CopilotNativeSelections;systemPrompt?:string;instructions?:string;}
export function copilotEmptyHandle(value:CopilotEmptyDescriptor):AgentPersistenceHandle {
  const handle={providerId:'copilot',sessionId:value.sessionId,opaque:nativeCanonical(value)};
  serializeAgentEmptyCreationResult({status:'created',handle});return handle;
}
export function readCopilotEmptyHandle(handle:AgentPersistenceHandle,authority:AgentNativeAuthorityScope):CopilotEmptyDescriptor|undefined {
  if(handle.providerId!=='copilot') rejectNativeEvidence('native_evidence_invalid');nativeIdentity(handle.sessionId);
  text(handle.opaque,limits.handleBytes);let value:any;
  try {value=JSON.parse(handle.opaque);} catch {rejectNativeEvidence('native_evidence_invalid');}
  if(value?.kind!=='copilot.empty') return undefined;
  object(value,['version','kind','sessionId','cwd','authority','selections'],['systemPrompt','instructions']);
  if(value.version!==1||value.sessionId!==handle.sessionId||!same(value.authority,authority)) rejectNativeEvidence('native_evidence_stale');
  text(value.cwd,limits.cwdBytes);if(!isAbsolute(value.cwd)||value.cwd.includes('\0')) rejectNativeEvidence('native_evidence_invalid');
  object(value.selections,['model','mode'],['reasoningEffort','contextTier','agent','toolApproval']);
  for(const key of ['model','reasoningEffort','contextTier','agent']) if(value.selections[key]!==undefined) {text(value.selections[key],limits.selectionBytes);if(!value.selections[key]) rejectNativeEvidence('native_evidence_invalid');}
  if(!['interactive','plan','autopilot'].includes(value.selections.mode)||value.selections.toolApproval!==undefined&&!['ask','allow'].includes(value.selections.toolApproval)) rejectNativeEvidence('native_evidence_invalid');
  for(const key of ['systemPrompt','instructions']) if(value[key]!==undefined) text(value[key],limits.systemBytes);
  const descriptor=value as unknown as CopilotEmptyDescriptor;
  copilotEmptyHandle(descriptor);return descriptor;
}

interface EvidencePorts {
  sessionId:string;cwd:string;authority:AgentNativeAuthorityScope;
  native():CopilotSession;isOpen():boolean;
  call<T>(operation:Promise<T>,label:string):Promise<T>;
  pendingInteractionIds():readonly string[];
  system():string;
  confirmedToolApproval():'ask'|'allow'|undefined;
  confirmedSelections(selections:CopilotNativeSelections):void;
}
interface Invocation {witness:string;selections:AgentPreparedTextInput['selections'];messageId?:string;}
/** Correlation belongs to one owned stdio attachment. A missing receipt never authorizes replay. */
export class CopilotSessionNativeEvidence implements AgentSessionNativeEvidence {
  private revision=0;
  private effects=0;
  private baseline?:{revision:number;facts:AgentNativeReadiness;selections:CopilotNativeSelections};
  private readonly tokens=new WeakMap<object,number>();
  private readonly invocations=new Map<string,Invocation>();
  constructor(private readonly ports:EvidencePorts) {}
  availability():ReturnType<AgentSessionNativeEvidence['availability']> {return this.ports.isOpen()?{status:'configured',version:2}:{status:'unavailable',code:'native_evidence_unavailable',reason:reasons.native_evidence_unavailable};}
  invalidate():void {this.revision++;this.baseline=undefined;}
  beginEffect():()=>void {this.invalidate();this.effects++;let finished=false;return()=>{if(!finished){finished=true;this.effects--;this.invalidate();}};}
  accept(event:SessionEvent):void {
    if(event.type==='abort'||/^(user\.message|assistant\.(turn_start|turn_end|idle|message)|session\.(idle|error|shutdown|model_change|mode_changed|permissions_changed|task_complete|cwd_changed|compaction_|snapshot_rewind)|pending_messages\.|permission\.|user_input\.|exit_plan_mode\.|elicitation\.|subagent\.|tool\.execution_)/.test(event.type)) this.invalidate();
  }
  private assertOpen():void {if(!this.ports.isOpen()) rejectNativeEvidence('native_evidence_stale');}
  async readSelections():Promise<CopilotNativeSelections> {
    this.assertOpen();const native=this.ports.native();
    const [model,selected,mode]=await this.ports.call(Promise.all([native.rpc.model.getCurrent(),native.rpc.agent.getCurrent(),native.rpc.mode.get()]),'Read Copilot native selections');
    this.assertOpen();
    if(typeof model.modelId!=='string'||!model.modelId||!['interactive','plan','autopilot'].includes(mode)) rejectNativeEvidence('native_evidence_unsupported');
    const agent=selected.agent?.id??selected.agent?.name;
    const selections:CopilotNativeSelections={model:model.modelId,mode,...(model.reasoningEffort?{reasoningEffort:model.reasoningEffort}:{}),...(model.contextTier?{contextTier:model.contextTier}:{}),...(agent?{agent}:{}),...(this.ports.confirmedToolApproval()?{toolApproval:this.ports.confirmedToolApproval()}: {})};
    return selections;
  }
  async inspectReadiness():Promise<AgentNativeReadiness> {
    this.assertOpen();if(this.effects) rejectNativeEvidence('native_evidence_stale');const revision=this.revision;const native=this.ports.native();
    const [metadata,processing,pending,permissions,tasks,selections]=await this.ports.call(Promise.all([
      native.rpc.metadata.snapshot(),native.rpc.metadata.isProcessing(),native.rpc.queue.pendingItems(),native.rpc.permissions.pendingRequests(),native.rpc.tasks.list(),this.readSelections(),
    ]),'Read Copilot native readiness');
    const cwd=await realpath(metadata.workingDirectory);
    this.assertOpen();if(revision!==this.revision||this.effects) rejectNativeEvidence('native_evidence_stale');
    if(metadata.sessionId!==this.ports.sessionId||cwd!==this.ports.cwd||typeof processing.processing!=='boolean'||!Array.isArray(pending.items)||!Array.isArray(pending.steeringMessages)||!Array.isArray(permissions.items)||!Array.isArray(tasks.tasks)) rejectNativeEvidence('native_evidence_invalid');
    const inFlight=(pending as typeof pending&{inFlightSteeringCount?:number}).inFlightSteeringCount??0;
    if(!Number.isSafeInteger(inFlight)||inFlight<0||tasks.tasks.some(task=>!['running','idle','completed','failed','cancelled'].includes(task.status))) rejectNativeEvidence('native_evidence_unsupported');
    const interactionIds=new Set(this.ports.pendingInteractionIds());
    for(const permission of permissions.items) {if(typeof permission.requestId!=='string') rejectNativeEvidence('native_evidence_invalid');interactionIds.add(permission.requestId);}
    const facts={cwd,idle:!processing.processing,pendingInputs:pending.items.length+pending.steeringMessages.length+inFlight,pendingInteractions:interactionIds.size,activeChildren:tasks.tasks.filter(task=>task.status==='running').length};
    if(this.baseline&&(!same(this.baseline.facts,facts)||!same(this.baseline.selections,selections))) this.revision++;
    this.ports.confirmedSelections(selections);
    this.baseline={revision:this.revision,facts,selections};return {...facts};
  }
  async emptySelections():Promise<CopilotNativeSelections> {await this.inspectReadiness();this.captureValidity();return {...this.baseline!.selections};}
  private current():boolean {return this.ports.isOpen()&&!this.effects&&this.baseline?.revision===this.revision;}
  captureValidity():AgentNativeValidityToken {if(!this.current()) rejectNativeEvidence('native_evidence_stale');const token=Object.freeze(Object.create(null)) as AgentNativeValidityToken;this.tokens.set(token,this.revision);return token;}
  isCurrent(token:AgentNativeValidityToken):boolean {return !!token&&typeof token==='object'&&this.current()&&this.tokens.get(token)===this.revision;}
  private selections(values:CopilotNativeSelections,delivery?:'immediate'):AgentPreparedTextInput['selections'] {
    return {model:values.model,...(values.reasoningEffort?{reasoningEffort:values.reasoningEffort}:{}),...(values.agent?{agent:values.agent}:{}),system:this.ports.system(),providerOptions:nativeCanonical({mode:values.mode,...(values.contextTier?{contextTier:values.contextTier}:{}),...(values.toolApproval?{toolApproval:values.toolApproval}:{})}),...(delivery?{delivery}:{})};
  }
  async prepareInput(parts:readonly AgentInputPart[],options?:AgentMessageOptions):Promise<AgentPreparedTextInput> {
    if(!Array.isArray(parts)||parts.length!==1||Object.getOwnPropertyNames(parts).length!==2||Object.getOwnPropertySymbols(parts).length) rejectNativeEvidence('native_evidence_invalid');
    const field=Object.getOwnPropertyDescriptor(parts,'0');if(!field||!('value'in field)) rejectNativeEvidence('native_evidence_invalid');object(field.value,['type','text']);
    if(field.value.type!=='text') rejectNativeEvidence('native_evidence_unsupported');text(field.value.text,limits.textBytes);
    if(options!==undefined) {object(options,[],['delivery']);if(options.delivery!==undefined&&options.delivery!=='immediate') rejectNativeEvidence('native_evidence_unsupported');}
    await this.inspectReadiness();this.captureValidity();
    const body=field.value.text;
    return parseAgentPreparedTextInput(serializeAgentPreparedTextInput({version:2,providerId:'copilot',nativeSessionId:this.ports.sessionId,inputId:randomUUID(),cwd:this.ports.cwd,authority:this.ports.authority,
      parts:[{type:'text',text:body}],content:{encoding:'utf-8',bytes:Buffer.byteLength(body),sha256:nativeHash(body)},selections:this.selections(this.baseline!.selections,options?.delivery==='immediate'?'immediate':undefined)}));
  }
  private matches(witness:AgentPreparedTextInput):boolean {return witness.providerId==='copilot'&&witness.nativeSessionId===this.ports.sessionId&&witness.cwd===this.ports.cwd&&same(witness.authority,this.ports.authority);}
  async dispatchInput(value:AgentPreparedTextInput) {
    const witness=parseAgentPreparedTextInput(serializeAgentPreparedTextInput(value));
    if(!this.matches(witness)) rejectNativeEvidence('native_evidence_stale');
    if(this.invocations.has(witness.inputId)) throw new AgentNativeEvidenceOutcomeUnknownError();
    if(this.invocations.size>=256) rejectNativeEvidence('native_evidence_limit');
    const facts=await this.inspectReadiness();
    if(!facts.idle||facts.pendingInputs||facts.pendingInteractions||facts.activeChildren||!same(witness.selections,this.selections(this.baseline!.selections,witness.selections.delivery))) rejectNativeEvidence('native_evidence_admission');
    this.captureValidity();const invocation:Invocation={witness:serializeAgentPreparedTextInput(witness),selections:witness.selections};this.invocations.set(witness.inputId,invocation);
    const finish=this.beginEffect();
    try {
      const sending=this.ports.native().send({prompt:witness.parts[0].text,mode:'immediate'});
      // A transport deadline does not end the native invocation.
      void sending.then(finish,finish);
      void sending.then(messageId=>{nativeIdentity(messageId);invocation.messageId=messageId;}).catch(()=>{});
      await this.ports.call(sending,'Send Copilot witnessed input');this.assertOpen();
      const result=await this.inspectInput(witness);if(result.status==='materialized'&&result.execution) return {disposition:'started' as const};
    } catch {throw new AgentNativeEvidenceOutcomeUnknownError();}
  }
  async inspectInput(value:AgentPreparedTextInput):Promise<AgentInputMaterialization> {
    const witness=parseAgentPreparedTextInput(serializeAgentPreparedTextInput(value));
    if(!this.ports.isOpen()||!this.matches(witness)) return unknown('native_evidence_stale');
    const invocation=this.invocations.get(witness.inputId);
    if(!invocation?.messageId||invocation.witness!==serializeAgentPreparedTextInput(witness)) return unknown('native_evidence_outcome_unknown');
    try {
      const events=await this.ports.call(this.ports.native().getEvents(),'Read Copilot witnessed input');
      if(!this.ports.isOpen()) return unknown('native_evidence_stale');
      const users=events.filter(event=>event.type==='user.message'&&!event.agentId&&(event.data as {messageId?:unknown}).messageId===invocation.messageId);
      if(users.length!==1) return unknown(users.length?'native_evidence_readback_mismatch':'native_evidence_readback_missing');
      const user=users[0]!;const data=user.data as {content?:unknown;interactionId?:unknown;attachments?:unknown[];parentToolCallId?:unknown};nativeIdentity(user.id);
      if(data.parentToolCallId||data.content!==witness.parts[0].text||data.attachments?.length||nativeHash(data.content as string)!==witness.content.sha256) return unknown('native_evidence_readback_mismatch');
      const {delivery:_delivery,...selections}=invocation.selections;
      const result:AgentInputMaterialization={status:'materialized',proof:{version:2,providerId:'copilot',nativeSessionId:witness.nativeSessionId,inputId:witness.inputId,nativeInputId:user.id,cwd:witness.cwd,authority:witness.authority,witnessSha256:nativeHash(invocation.witness),contentSha256:witness.content.sha256,nativeSelectionsSha256:nativeHash(JSON.stringify(selections))}};
      if(typeof data.interactionId==='string'&&data.interactionId) {
        const starts=events.filter((event):event is SessionEvent&{type:'assistant.turn_start'}=>event.type==='assistant.turn_start'&&!event.agentId&&!(event.data as {parentToolCallId?:unknown}).parentToolCallId&&event.data.interactionId===data.interactionId);
        const first=starts[0];
        if(first) {nativeIdentity(first.id);if(first.data.model&&first.data.model!==witness.selections.model) return unknown('native_evidence_readback_mismatch');result.execution={disposition:'started',nativeExecutionId:first.id};}
      }
      return parseAgentInputMaterialization(serializeAgentInputMaterialization(result));
    } catch {return unknown('native_evidence_readback_failed');}
  }
}
