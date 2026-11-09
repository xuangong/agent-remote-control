import { useRef, type KeyboardEvent } from 'react';

/** A macOS-style segmented control: one pressed segment; Left and Right move the choice.
 *  `onChange` is a function property, not a method: a method's parameter is bivariant, so a state setter
 *  passed to it would widen T to string. */
export function SegmentedControl<T extends string>({ label, options, value, onChange, className }: {
  label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void; className?: string;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = options[(index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]!;
    onChange(next.value);
    buttons.current.get(next.value)?.focus();
  };
  return <nav className={className ? `ui-segmented ${className}` : 'ui-segmented'} aria-label={label}>
    {options.map((option, index) => <button key={option.value} type="button" aria-pressed={option.value === value}
      ref={node => { if (node) buttons.current.set(option.value, node); else buttons.current.delete(option.value); }}
      onClick={() => onChange(option.value)} onKeyDown={event => move(event, index)}>{option.label}</button>)}
  </nav>;
}
