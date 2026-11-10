import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type SegmentedActivation = 'automatic' | 'manual';

/** A macOS-style segmented control: one pressed segment and one Tab stop. Left and Right move along the segments,
 *  wrapping around. With automatic activation they also choose; with manual activation they only move the focus and
 *  Enter or Space chooses, for choices that hide the control, such as the workbench mode.
 *  A `landmark` control is a `<nav>`, for navigation between places such as the workbench modes; otherwise it is a `role="group"`.
 *  `onChange` is a function property, not a method: a method's parameter is bivariant, so a state setter
 *  passed to it would widen T to string. */
export function SegmentedControl<T extends string>({ label, options, value, onChange, activation = 'automatic', className, landmark = false }: {
  label: string; options: readonly { value: T; label: ReactNode }[]; value: T; onChange: (value: T) => void;
  activation?: SegmentedActivation; className?: string; landmark?: boolean;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const [focused, setFocused] = useState<T>();
  // The Tab stop is the focused segment while focus is inside, otherwise the chosen one, so it is always reachable.
  const stop = [focused, value].find(candidate => options.some(option => option.value === candidate)) ?? options[0]?.value;
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = options[(index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]!;
    if (activation === 'automatic') onChange(next.value);
    buttons.current.get(next.value)?.focus();
  };
  const Root = landmark ? 'nav' : 'div';
  return <Root className={className ? `ui-segmented ${className}` : 'ui-segmented'} role={landmark ? undefined : 'group'} aria-label={label}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined); }}>
    {options.map((option, index) => <button key={option.value} type="button" aria-pressed={option.value === value}
      tabIndex={option.value === stop ? 0 : -1}
      ref={node => { if (node) buttons.current.set(option.value, node); else buttons.current.delete(option.value); }}
      onFocus={() => { if (option.value !== stop) setFocused(option.value); }}
      onClick={() => onChange(option.value)} onKeyDown={event => move(event, index)}>{option.label}</button>)}
  </Root>;
}
