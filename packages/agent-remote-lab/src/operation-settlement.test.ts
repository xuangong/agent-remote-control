// @vitest-environment node
import { it } from 'vitest';
import { checksAuthority, retainsHandled, settlesOnce, standalone } from './test/operation-settlement.js';

it('standalone settles once across lost receipts, fresh connections and reconnect', async () => settlesOnce(await standalone()), 20000);
it('checks authority before cached receipts and binds intent to native identity across public bindings', async () => checksAuthority(await standalone()), 20000);
it('standalone retains handled acceptance across a lost receipt and reconnect', async () => retainsHandled(await standalone({ disposition: 'handled' })));
