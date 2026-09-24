import { createInterface } from 'node:readline';
let sequence = 0;
let activeTurn;
let config = {};
let effort = 'medium';
const runtimeInfo = () => ({ providerId: 'stdio-fixture', sessionId: config.sessionId, status: activeTurn ? 'running' : 'idle', cwd: config.cwd, model: 'fixture', settings: [{ id: 'reasoning', category: 'model', label: 'Reasoning effort', value: effort, options: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }], mutable: true, scope: 'session' }] });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const emit = event => send({ type: 'event', value: { type: 'observation', sourceKey: `fixture-${++sequence}`, occurredAt: Date.now(), delivery: 'live', event: { provider: 'stdio-fixture', ...event } } });
const message = (type, text) => emit({ type: 'timeline', turnId: activeTurn, item: { type, text, messageId: `message-${sequence}` } });
const finish = () => { emit({ type: 'turn_completed', turnId: activeTurn }); activeTurn = undefined; };
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'start') { config = request.args[0]; send({ type: 'event', value: { type: 'history_boundary' } }); }
  if (request.method === 'setSessionSetting') {
    if (request.args[0] !== 'reasoning' || !['medium', 'high'].includes(request.args[1])) { send({ type: 'result', id: request.id, error: 'Invalid setting' }); continue; }
    effort = request.args[1]; emit({ type: 'runtime_updated', runtimeInfo: runtimeInfo() });
  }
  if (request.method === 'sendMessage') {
    activeTurn = `turn-${sequence}`;
    emit({ type: 'turn_started', turnId: activeTurn });
    message('user_message', request.args[0]);
    if (request.args[0] === 'trace') emit({ type: 'timeline', turnId: activeTurn, item: { type: 'reasoning', text: 'Fixture reasoning detail' } });
    if (request.args[0] === 'approve') {
      emit({ type: 'interaction_requested', request: { kind: 'tool_approval', requestId: 'fixture-approval', toolCallId: 'fixture-tool', toolName: 'fixture', summary: 'Fixture approval', detail: { type: 'other', description: 'Fixture action' }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once'] } });
    } else if (request.args[0] !== 'hold') {
      message('assistant_message', `STDIO reply: ${request.args[0]}`); finish();
    }
  }
  if (request.method === 'cancel') { emit({ type: 'turn_canceled', turnId: activeTurn, reason: 'Canceled by client' }); activeTurn = undefined; }
  if (request.method === 'respondToInteraction') {
    emit({ type: 'interaction_resolved', requestId: request.args[0], response: request.args[1] });
    message('assistant_message', 'Approval received'); finish();
  }
  send({ type: 'result', id: request.id, value: request.method === 'runtimeInfo' ? runtimeInfo() : undefined });
}
