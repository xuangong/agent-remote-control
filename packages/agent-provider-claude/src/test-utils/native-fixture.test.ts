import { expect, it } from 'vitest';
import { nativeFixture, nativeReply } from './native-fixture.js';

const title = { tools: [], messages: [{ role: 'user', content: [{ type: 'text',
  text: '<session>\nFIXTURE_INPUT\n</session>\n\nWrite the title in the predominant language of the session — keep it short.' }] }] };

it('keeps auxiliary title requests out of the scripted turn and its usage', async () => {
  const handled: unknown[] = [];
  const fixture = await nativeFixture((body, response) => { handled.push(body); nativeReply(response, [{ type: 'text', text: 'TURN_RESULT' }]); });
  const post = async (body: unknown) => (await fetch(`${fixture.options.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2000),
  })).text();
  try {
    const titleResponse = await post(title);
    expect(titleResponse).toContain('Isolated native fixture');
    expect(titleResponse).toContain('"input_tokens":0');
    expect(titleResponse).toContain('"output_tokens":0');
    expect(handled).toEqual([]);
    expect(fixture.bodies).toEqual([]);
    expect(fixture.sessionTitles).toEqual([title]);
    const turn = { messages: [{ role: 'user', content: 'FIXTURE_INPUT' }] };
    expect(await post(turn)).toContain('TURN_RESULT');
    expect(handled).toEqual([turn]);
    expect(fixture.bodies).toEqual([turn]);
    expect(fixture.requests).toHaveLength(2);
  } finally { await fixture.close(); }
}, 5000);

it('forwards and records native title requests when evidence collection handles them', async () => {
  const handled: unknown[] = [];
  const fixture = await nativeFixture((body, response) => { handled.push(body); nativeReply(response, [{ type: 'text', text: 'EVIDENCE_TITLE' }]); }, { sessionTitles: 'manual' });
  try {
    const response = await fetch(`${fixture.options.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST', body: JSON.stringify(title), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2000),
    });
    const stream = await response.text();
    expect(stream).toContain('EVIDENCE_TITLE');
    expect(stream).toContain('"input_tokens":10');
    expect(handled).toEqual([title]);
    expect(fixture.bodies).toEqual([title]);
    expect(fixture.sessionTitles).toEqual([title]);
    expect(fixture.requests).toHaveLength(1);
  } finally { await fixture.close(); }
}, 5000);
