# Composable session companions

A session may optionally use an execution todo list, user confirmation, and heartbeat scheduling. These are application capabilities composed through ordinary `AgentSessionExtensions`; they are not new native session types. TPM is their first product consumer.

## Boundaries

- The Provider SDK defines instruction/tool extensions. Adapters deliver them to the native provider without interpreting business progress.
- The Host owns durable todo state, atomic revision checks, user decisions and scheduling. A view disappearing does not erase the list or stop an enabled heartbeat.
- `SessionTodoPanel` renders a `SessionTodoList` and emits a `SessionTodoDecision`. The ordinary `SessionWorkbench` accepts it through an optional `todo` property. A consumer supplies the authenticated management operation.
- A role supplies instructions and an initial list. TPM additionally supplies main-session communication and delivery reporting. Other roles need neither TPM routes nor its main-session concept to use the exported toolkit.
- Native status, operation acceptance and todo completion remain separate. This list is not a replacement for provider-native planning events rendered in the timeline.

## Sequential execution

Only the first unfinished step can change progress. A task must start before completion and must record evidence. A confirmation step can only complete through an explicit user decision; no model tool accepts user decisions. Silence, a heartbeat, natural-language model interpretation or native idle cannot approve a gate.

The model can replace the unfinished suffix at step boundaries. Completed steps remain immutable and pending confirmation steps cannot be removed or converted into tasks. After user approval, changing the remaining plan inserts a fresh confirmation before changed work. Removed steps are shown in the proposed change; bounded change history preserves previous definitions. Returning to completed work appends new steps rather than resetting old evidence.

Confirmation binds the current list revision and a request identity. Changing the proposal invalidates the old request. An attached specification must invalidate consent when it changes; TPM does this for document and acceptance changes. Heartbeat writes use separate work revisions and do not invalidate an unchanged confirmation.

Every step in the current list must complete before the list is complete. TPM additionally requires work-level acceptance criteria and evidence before marking delivery complete. These checks establish recorded assessment, not proof that a model's judgment is correct.

## Composition

The Controller exports `createSessionTodo`, `changeSessionTodo`, `confirmSessionTodo`, `sessionTodoTools`, and `sessionHeartbeatTools`. The todo tool factory takes a storage adapter with `read()` and `change(input)`; `change` must use the transition reducer inside an atomic durable update and publish only after persistence. The user decision reducer belongs behind authenticated user management, never in the model's toolkit.

```ts
const extensions = {
  instructions: [roleInstructions, sessionTodoInstructions, sessionHeartbeatInstructions].join('\n\n'),
  tools: [
    ...sessionTodoTools(todoAccess),
    ...sessionHeartbeatTools(heartbeatAccess),
  ],
};
```

Either toolkit can be omitted. Heartbeat supplies cadence bounds and the scheduling tool; its host supplies durable due times, a wake loop, native admission checks and review dispatch. A todo list by itself does not run a timer. Existing session extension capability/ownership checks still apply, including when a provider cannot modify tools on an already open session.

The product currently enables this composition through TPM creation. There is no new universal toggle that retrofits tools onto arbitrary running native sessions.

## Dispatch and limits

TPM main-session messages include the current todo step and plan revision. Admission and pre-dispatch checks reject stale or unapproved execution. Implementation and acceptance feedback require user approval of the current plan and specification. Changing the plan does not undo a message already accepted by the native runtime. Unknown native outcomes are never replayed automatically.

This is not a native sandbox. A model that retains direct shell/file tools is not mechanically prevented from doing unrelated work outside the managed dispatch channel. Semantic correctness and attribution remain model/user judgments. The application enforces sequence, consent, identity and persistence for the operations it owns.

Lists contain at most 100 steps, retain at most 20 plan changes, and occupy at most 128 KiB. Confirmation text and evidence are bounded. Store restore and management response validation use the public schema. There is no arbitrary script execution, graph engine, or second chat renderer.
