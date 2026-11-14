/** Line icons on a 24-pixel grid with round caps and joins, drawn for this app (SF Symbols are licensed for Apple platforms only). */
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13zM15.8 15.8L20 20',
  sidebar: 'M4 5.5h16v13H4zM9.5 5.5v13',
  dock: 'M4 5.5h16v13H4zM14.5 5.5v13M17 9h.5M17 12h.5M17 15h.5',
  ellipsis: 'M6 11a1 1 0 1 1 0 2a1 1 0 1 1 0-2zM12 11a1 1 0 1 1 0 2a1 1 0 1 1 0-2zM18 11a1 1 0 1 1 0 2a1 1 0 1 1 0-2z',
  close: 'M6 6l12 12M18 6L6 18',
  star: 'M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z',
  'chevron-right': 'M9.5 6l6 6-6 6',
  'chevron-left': 'M14.5 6l-6 6 6 6',
  'chevron-down': 'M6 9.5l6 6 6-6',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7z',
  gear: 'M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6zM12 5a7 7 0 1 1 0 14a7 7 0 1 1 0-14zM12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8',
  window: 'M3.5 5.5h17v13h-17zM3.5 9h17',
  team: 'M9 11a3 3 0 1 1 0-6a3 3 0 1 1 0 6zM3.5 19c.7-3 2.9-4.5 5.5-4.5s4.8 1.5 5.5 4.5M16 11a2.5 2.5 0 1 0 0-5M17.5 14.6c1.6.5 2.6 1.9 3 4.4',
  list: 'M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01',
  question: 'M12 21a9 9 0 1 1 0-18a9 9 0 1 1 0 18zM9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8M12 17h.01',
  sessions: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
  person: 'M12 12a4 4 0 1 1 0-8a4 4 0 1 1 0 8zM4.5 20c.9-3.8 3.9-6 7.5-6s6.6 2.2 7.5 6',
  pin: 'M9 4h6l-1 5 3 3H7l3-3zM12 12v8',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  'eye-off': 'M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.6 2.3-3.2 3.6M6.6 7.7C4.6 9 3.2 10.9 2.5 12c1 1.5 4.5 6 9.5 6 1.5 0 2.9-.4 4.1-1',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warning: 'M12 4l9 16H3zM12 10v4.5M12 17.5h.01',
  refresh: 'M19 12a7 7 0 1 1-2.05-4.95M19 4.5v4h-4',
  grid: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  trash: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6',
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className="ui-icon" aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d={PATHS[name]} />
  </svg>;
}
