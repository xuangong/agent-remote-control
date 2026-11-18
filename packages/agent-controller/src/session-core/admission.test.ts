import { describe, expect, it } from 'vitest';

import { createAdmission } from './admission.js';

describe('admission', () => {
  it('takes everything while open', () => {
    const admission = createAdmission();
    expect(admission.phase).toBe('open');
    expect(admission.stopped).toBe(false);
    expect(admission.refuse('POST')).toBeUndefined();
    expect(admission.refuse('GET')).toBeUndefined();
  });

  it('refuses new mutations while draining, and still answers reads', () => {
    const admission = createAdmission();
    expect(admission.beginDrain()).toBe(true);
    expect(admission.stopped).toBe(true);
    expect(admission.refuse('POST')).toEqual({ code: 'controller_updating', message: 'Controller is updating. Reconnect before retrying.' });
    expect(admission.refuse('GET')).toBeUndefined();
  });

  it('begins a drain only from open', () => {
    const admission = createAdmission();
    expect(admission.beginDrain()).toBe(true);
    expect(admission.beginDrain()).toBe(false);
    admission.close();
    expect(admission.beginDrain()).toBe(false);
  });

  it('returns a draining Controller to open when the restart is cancelled', () => {
    const admission = createAdmission();
    admission.beginDrain();
    admission.cancelDrain();
    expect(admission.phase).toBe('open');
    expect(admission.stopped).toBe(false);
    expect(admission.beginDrain()).toBe(true);
  });

  it('refuses every method once closed, and never reopens', () => {
    const admission = createAdmission();
    admission.close();
    expect(admission.closed).toBe(true);
    expect(admission.refuse('GET')).toEqual({ code: 'host_closed', message: 'Agent Host is closed.' });
    expect(admission.refuse('POST')).toEqual({ code: 'host_closed', message: 'Agent Host is closed.' });
    admission.cancelDrain();
    expect(admission.closed).toBe(true);
  });

  it('closes from a drain, and keeps reporting the drain as stopped', () => {
    const admission = createAdmission();
    admission.beginDrain();
    admission.close();
    expect(admission.closed).toBe(true);
    expect(admission.draining).toBe(true);
  });
});
