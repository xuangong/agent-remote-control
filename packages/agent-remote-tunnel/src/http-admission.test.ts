import { expect, it } from 'vitest';
import { PreviewHttpAdmission } from './http-admission.js';

it('bounds waiting requests and admits the oldest surviving request when a slot releases', async () => {
  const queue = new PreviewHttpAdmission(1, 2);
  const release = await queue.acquire();
  const abort = new AbortController();
  const cancelled = queue.acquire(abort.signal);
  const next = queue.acquire();
  await expect(queue.acquire()).rejects.toMatchObject({ code: 'capacity' });
  abort.abort(); await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
  release(); release();
  const releaseNext = await next;
  let started = false;
  const last = queue.acquire().then(done => { started = true; return done; });
  await Promise.resolve(); expect(started).toBe(false);
  releaseNext(); (await last)(); queue.close();
});

it('removes timed out and cancelled requests without consuming slots', async () => {
  const queue = new PreviewHttpAdmission(1, 1, 10);
  const release = await queue.acquire();
  await expect(queue.acquire()).rejects.toMatchObject({ code: 'timeout' });
  const abort = new AbortController(); abort.abort();
  await expect(queue.acquire(abort.signal)).rejects.toMatchObject({ code: 'cancelled' });
  const next = queue.acquire(); release(); (await next)(); queue.close();
});

it('rejects pending and future requests when the tunnel closes', async () => {
  const queue = new PreviewHttpAdmission(1);
  const release = await queue.acquire();
  const pending = queue.acquire();
  queue.close();
  await expect(pending).rejects.toMatchObject({ code: 'closed' });
  release(); await expect(queue.acquire()).rejects.toMatchObject({ code: 'closed' });
});
