import { describe, expect, it } from 'vitest';
import { destinationOf, destinationUrl, initialMode, modeOf, readDefaultView, SETTINGS_GROUP_IDS, type DestinationPlace } from './destinations.js';
import { DESTINATION_VECTORS, INITIAL_MODE_VECTORS } from './destinations.vectors.js';

const at = (path: string) => new URL(path, 'https://orchard.test');

describe('destinations', () => {
  it.each(DESTINATION_VECTORS)('$url in $mode mode is $place.destination', ({ url, mode, place }) => {
    expect(destinationOf(at(url), mode)).toEqual(place);
  });

  it('writes a destination over any address and reads it back, leaving every other parameter as it was', () => {
    const targets: DestinationPlace[] = [{ destination: 'settings' }, ...SETTINGS_GROUP_IDS.map(group => ({ destination: 'settings' as const, group })),
      { destination: 'assistants' }, { destination: 'chats' }, { destination: 'windows' }];
    for (const { url, mode } of DESTINATION_VECTORS) for (const target of targets) {
      const written = destinationUrl(at(url), target);
      const shown = destinationOf(written, modeOf(target.destination, mode));
      expect(shown, `${url} → ${JSON.stringify(target)}`).toEqual(target);
      const others = (value: URL) => [...value.searchParams].filter(([key]) => key !== 'page' && key !== 'group');
      expect(others(written)).toEqual(others(at(url)));
    }
  });

  it('chooses the mode underneath: Chats and Windows set it, Settings and the directory keep it', () => {
    expect([modeOf('chats', 'window'), modeOf('windows', 'bot'), modeOf('settings', 'bot'), modeOf('assistants', 'window')]).toEqual(['bot', 'window', 'bot', 'window']);
  });

  it.each(INITIAL_MODE_VECTORS)('opens in $mode: named $named, stored $stored, default $defaultView, phone $phone', ({ mode, ...facts }) => {
    expect(initialMode(facts)).toBe(mode);
  });

  it.each([[null, 'last'], ['chats', 'chats'], ['windows', 'windows'], ['last', 'last'], ['bot', 'last']] as const)('reads the stored default view %j as %s', (stored, view) => {
    expect(readDefaultView(stored)).toBe(view);
  });
});
