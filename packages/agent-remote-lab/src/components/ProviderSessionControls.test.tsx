import { describe, expect, it, vi } from 'vitest';

import { ProviderSessionControls } from './ProviderSessionControls.js';
import { render } from '../test/setup.js';

describe('ProviderSessionControls', () => {
  it('keeps session creation unavailable until a provider is available', async () => {
    const container = await render(<ProviderSessionControls providers={[]} selectedProviderId="" catalogStatus="empty" onRetryProviders={() => undefined} onSelectedProviderChange={() => undefined} onCreateSession={() => undefined} creating={false} />);
    expect((container.querySelector('[data-testid="session-create"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('No provider registered');
  });

  it('uses the selected provider for an enabled session creation control', async () => {
    const select = vi.fn();
    const create = vi.fn();
    const container = await render(<ProviderSessionControls providers={[{ providerId: 'recording', displayName: 'Recorded trace' }]} selectedProviderId="recording" catalogStatus="ready" onRetryProviders={() => undefined} onSelectedProviderChange={select} onCreateSession={create} creating={false} />);
    const providerSelect = container.querySelector('[data-testid="provider-select"]') as HTMLSelectElement;
    providerSelect.value = 'recording';
    providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    (container.querySelector('[data-testid="session-create"]') as HTMLButtonElement).click();
    expect(select).toHaveBeenCalledWith('recording');
    expect(create).toHaveBeenCalledOnce();
    expect((container.querySelector('[data-testid="session-create"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the retryable catalog failure associated with session creation', async () => {
    const container = await render(<ProviderSessionControls
      providers={[]}
      selectedProviderId=""
      catalogStatus="error"
      catalogError="Catalog unavailable."
      onRetryProviders={() => undefined}
      onSelectedProviderChange={() => undefined}
      onCreateSession={() => undefined}
      creating={false}
    />);

    const create = container.querySelector('[data-testid="session-create"]') as HTMLButtonElement;
    const descriptionId = create.getAttribute('aria-describedby');
    expect(descriptionId).toBe('session-create-note');
    expect(document.getElementById(descriptionId!)?.textContent).toContain('Catalog unavailable.');
  });

  it('exposes resume only for a resumable session that is not transitioning', async () => {
    const persistence = { providerId: 'recording', sessionId: 'session-7', opaque: 'resume-7' };
    const container = await render(<ProviderSessionControls providers={[{ providerId: 'recording', displayName: 'Recorded trace' }]} selectedProviderId="recording" catalogStatus="ready" onRetryProviders={() => undefined} onSelectedProviderChange={() => undefined} onCreateSession={() => undefined} creating={false} persistence={persistence} onResumeSession={() => undefined} />);
    const button = container.querySelector('[data-testid="session-resume"]') as HTMLButtonElement | null;

    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute('aria-describedby')).toBe('session-resume-note');
  });
});
