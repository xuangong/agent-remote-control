import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../test/setup.js';
import { RecordedPlaybackControls } from './RecordedPlaybackControls.js';

describe('RecordedPlaybackControls', () => {
  it('exposes advance, rehydrate, and reader shutdown only when fixture controls are attached', async () => {
    const advance = vi.fn();
    const rehydrate = vi.fn();
    const stopReader = vi.fn();
    const container = await render(<RecordedPlaybackControls
      onAdvance={advance}
      onRehydrate={rehydrate}
      onStopReader={stopReader}
    />);

    await act(async () => (container.querySelector('[data-testid="playback-advance"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[data-testid="playback-rehydrate"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[data-testid="playback-stop-reader"]') as HTMLButtonElement).click());

    expect(advance).toHaveBeenCalledOnce();
    expect(rehydrate).toHaveBeenCalledOnce();
    expect(stopReader).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Provider resource reader stopped.');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Provider resource reader stopped.');
  });

  it('announces a rejected fixture action as an alert', async () => {
    const container = await render(<RecordedPlaybackControls onAdvance={async () => { throw new Error('Fixture unavailable.'); }} />);

    await act(async () => (container.querySelector('[data-testid="playback-advance"]') as HTMLButtonElement).click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Fixture unavailable.');
  });
});
