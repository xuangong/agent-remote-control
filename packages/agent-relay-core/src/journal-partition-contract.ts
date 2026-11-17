import { expectEqual } from '@orchardworks/agent-remote-journal/testing';

import type { JournalPartitionApi } from './journal-partition.js';

/** One call of the contract and the reply it must get. The epoch the partition draws is written `<epoch>`; an absent argument or reply is `null`. */
export interface PartitionContractStep {
  method: keyof JournalPartitionApi;
  args: unknown[];
  reply: unknown;
}

/** What a Durable Object does to every call: arguments and results cross as structured clones. */
export function overStructuredClone(api: JournalPartitionApi): JournalPartitionApi {
  const wrap = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => structuredClone(await call(...structuredClone(args)));
  return {
    open: wrap(api.open), publish: wrap(api.publish), fill: wrap(api.fill), page: wrap(api.page), status: wrap(api.status), unserveHead: wrap(api.unserveHead),
    servedSessions: wrap(api.servedSessions), deleteHost: wrap(api.deleteHost), capabilities: wrap(api.capabilities),
  };
}

const masked = (value: unknown, epoch: string) => JSON.parse(JSON.stringify(value ?? null).replaceAll(epoch || '\u0000', '<epoch>').replace(/"protocolVersion":"[^"]*"/g, '"protocolVersion":"<version>"'));

/** Plays the steps of `journal-partition.contract.json`: every method of `JournalPartitionApi` with the arguments `primary` sends and the reply a partition gives. Each step is played against `api` in order and gives each step with the reply `api` gave, as the contract file records it. */
export async function playPartitionContract(api: JournalPartitionApi, steps: readonly PartitionContractStep[]): Promise<PartitionContractStep[]> {
  let epoch = '';
  const played: PartitionContractStep[] = [];
  for (const step of steps) {
    const args = step.args.map(arg => (arg === '<epoch>' ? epoch : arg === null ? undefined : arg));
    const reply = await (api[step.method] as (...call: unknown[]) => Promise<unknown>)(...args);
    epoch = (reply as { cursor?: { epoch: string } } | undefined)?.cursor?.epoch ?? epoch;
    played.push({ method: step.method, args: step.args, reply: masked(reply, epoch) });
  }
  return played;
}

/** Throws at the first step whose reply differs from the contract file, so a change to an argument or a result of any method fails. */
export async function replayPartitionContract(api: JournalPartitionApi, steps: readonly PartitionContractStep[]): Promise<void> {
  const played = await playPartitionContract(api, steps);
  steps.forEach((step, index) => expectEqual(played[index]!.reply, masked(step.reply, '<epoch>'), `${step.method} ${JSON.stringify(step.args).slice(0, 80)}`));
}
