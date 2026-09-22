import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { useSessionStars, type SessionStars } from './useSessionStars.js';
import { SessionStarsClient } from '../session-stars-client.js';
import { FavoritesList, FavoritesMenu } from '../components/SessionFavorites.js';
import type { SessionTracking } from './useSessionTracking.js';
const star = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Research', starredAt: 1, favoriteId: 's', folderId: null, order: 0, available: true, online: true };
const tracking: SessionTracking = { replace: vi.fn(), sessions: [], backgroundSessions: [], observations: {}, observers: [], error: undefined, toggle: vi.fn(), retry: vi.fn(), acknowledge: vi.fn() };
afterEach(() => vi.restoreAllMocks());
it('keeps failed saves visible without pretending the favorite was saved', async () => {
  vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockResolvedValue({revision:0,folders:[],stars:[]});
  vi.spyOn(SessionStarsClient.prototype, 'command').mockRejectedValue(new Error('Host did not confirm the favorite.'));
  let favorites!: SessionStars;
  function Fixture() { favorites = useSessionStars('http://localhost/u/alice/', true); return <FavoritesList favorites={favorites} tracking={tracking} busy={false} onOpen={() => {}} />; }
  const view = await render(<Fixture />);
  await act(async () => favorites.toggle(star));
  expect(favorites.stars).toEqual([]);
  expect(view.textContent).toContain('Host did not confirm');
  expect(favorites.pending).toBeUndefined();
});
it('ignores a prior account response and allows the new account to refresh', async () => {
  let resolveOld!: (value: {revision:number;folders:[];stars:typeof star[]}) => void;
  vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({revision:0,folders:[],stars:[]});
  let change!: (value: string) => void;
  let favorites!: SessionStars;
  function Fixture() { const [scope, setScope] = useState('alice'); change = setScope; favorites = useSessionStars(`http://localhost/u/${scope}/`, true); return <p>{favorites.stars.map(item => item.title).join(',')}</p>; }
  const view = await render(<Fixture />);
  await act(async () => change('bob'));
  await act(async () => resolveOld({revision:1,folders:[],stars:[star]}));
  expect(view.textContent).not.toContain('Research');
  expect(favorites.loading).toBe(false);
});
it('shares favorites with the title menu and dismisses with Escape while restoring focus', async () => {
  const favorites: SessionStars = { enabled: true, scope: 'alice', revision: 1, folders: [], change: vi.fn(), stars: [star], loading: false, pending: undefined, error: undefined, toggle: vi.fn(), refresh: vi.fn(async () => {}) };
  const open = vi.fn();
  const view = await render(<FavoritesMenu title="Current session" favorites={favorites} tracking={tracking} busy={false} onOpen={open} />);
  const trigger = view.querySelector('button')!;
  await act(async () => trigger.click());
  expect(favorites.refresh).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(view.querySelector('section'));
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Actions for Research"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Track')!.click());
  expect(tracking.toggle).toHaveBeenCalledWith(star);
  await act(async () => view.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await act(async () => view.querySelector<HTMLButtonElement>('.lab-session-row')!.click());
  expect(open).toHaveBeenCalledWith(star);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
it('refreshes a stale tree after conflict without replaying the requested move', async () => {
  const { FavoritesConflict } = await import('../session-stars-client.js');
  vi.spyOn(SessionStarsClient.prototype, 'snapshot').mockResolvedValueOnce({revision:1,folders:[],stars:[star]})
    .mockResolvedValue({revision:2,folders:[{id:'work',parentId:null,title:'Work',order:0}],stars:[{...star,folderId:'work'}]});
  const command=vi.spyOn(SessionStarsClient.prototype,'command').mockRejectedValue(new FavoritesConflict('Favorites changed on another device.'));
  let favorites!:SessionStars;
  function Fixture(){favorites=useSessionStars('http://localhost/u/alice/',true);return <p>{favorites.error}</p>;}
  const view=await render(<Fixture/>);
  await act(async()=>{expect(await favorites.change({type:'move',id:'s',parentId:null,beforeId:null})).toBe(false);});
  expect(command).toHaveBeenCalledOnce();expect(command.mock.calls[0]?.[0].revision).toBe(1);
  expect(favorites.revision).toBe(2);expect(favorites.stars[0]?.folderId).toBe('work');
  expect(view.textContent).toContain('another device');expect(favorites.pending).toBeUndefined();
});
