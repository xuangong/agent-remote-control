import { afterEach, expect, it } from 'vitest';
import { PUBLIC_ID, seedJournal, startRelay, until } from './test-utils/journal-session-fixture.js';

const started: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });
async function relay() {
  const value = await startRelay({ seed: store => seedJournal(store) });
  started.push(value);
  return value;
}
const timelineRequest = (number: number) => ({ type: 'timeline_request', payload: { requestId: `read-${number}`, agentId: PUBLIC_ID, direction: 'tail', limit: 1 } });

it('does not close a stream that reads many pages, as a search through a long session does', async () => {
  const r = await relay();
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  await browser.take(frame => frame.type === 'agent_snapshot', 'Snapshot');
  for (let number = 0; number < 300; number++) browser.send(timelineRequest(number));
  await browser.take(frame => frame.type === 'timeline_page' && frame.payload.requestId === 'read-299', 'the last page');
  expect(browser.pair.native.readyState).toBe(1);
});

it('still closes a stream that floods timeline requests', async () => {
  const r = await relay();
  const browser = await r.openBrowser();
  browser.send({ type: 'negotiate' });
  await browser.take(frame => frame.type === 'agent_snapshot', 'Snapshot');
  for (let number = 0; number < 650; number++) browser.send(timelineRequest(number));
  await until(() => browser.pair.native.readyState === 3 ? true : undefined, 'the stream to close');
  expect(browser.pair.native.closeCode).toBe(1008);
});
