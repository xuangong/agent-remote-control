import { describe, expect, it } from 'vitest';
import { leaseDeadlineOnDeviceClock } from './lease-clock.js';
import { leaseClockVectors } from './lease-clock.vectors.js';

describe('leaseDeadlineOnDeviceClock', () => {
  it.each(leaseClockVectors)('$name', ({ input, deadline }) => {
    expect(leaseDeadlineOnDeviceClock(input)).toBe(deadline);
  });
});
