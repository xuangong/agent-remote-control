import { expect, it } from 'vitest';
import { SessionStarsClient } from './session-stars-client.js';

const checkpoint = { hostId: 'host', controllerId: 'installation', roleId: 'role', roleRevision: 3, operationId: 'op-3', status: 'applied' };
const tree = { revision: 7, folders: [], stars: [] };
const client = (progress: unknown) => new SessionStarsClient('https://relay.example/u/owner/', async () => Response.json({ ...tree, successionProgress: progress }));

it('preserves validated progress independently from the Favorites tree revision', async () => {
  expect((await client({ version: 1, roles: [checkpoint] }).snapshot()).successionProgress).toEqual({ version: 1, roles: [checkpoint] });
  expect((await client({ version: 1, roles: [] }).snapshot()).successionProgress).toEqual({ version: 1, roles: [] });
  expect(await new SessionStarsClient('https://relay.example/', async () => Response.json(tree)).snapshot()).toEqual(tree);
});

it.each([
  null, { version: 2, roles: [] }, { version: 1, roles: 'invalid' },
  { version: 1, roles: [checkpoint, checkpoint] },
  ...[{ roleRevision: 0 }, { roleRevision: 1.5 }, { status: 'unknown' }, { hostId: '' }, { roleId: '' }, { operationId: '' }, { controllerId: '' }, { token: 'internal' }]
    .map(change => ({ version: 1, roles: [{ ...checkpoint, ...change }] })),
  { version: 1, roles: Array.from({ length: 1025 }, (_, index) => ({ ...checkpoint, roleId: `role-${index}` })) },
])('rejects invalid or excessive succession progress %#', async progress => {
  await expect(client(progress).snapshot()).rejects.toThrow('invalid');
});
