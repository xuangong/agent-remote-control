import './primary-session-groups.css';

export interface PrimarySessionGroupOption { id: string; title: string; selected: boolean }
interface Props {
  groups: readonly PrimarySessionGroupOption[];
  onSelect(id: string): void; onCreate(): void; onClose(id: string): void;
}
export function PrimarySessionGroups({ groups, onSelect, onCreate, onClose }: Props) {
  return <nav className="lab-primary-groups" aria-label="Primary session groups">
    <div className="lab-primary-groups-list">{groups.map(group => <div className="lab-primary-group-option" key={group.id} data-selected={group.selected || undefined}>
      <button type="button" aria-label={`Select primary group: ${group.title}`} aria-current={group.selected || undefined} onClick={() => onSelect(group.id)}>
        <span>{group.title}</span>{group.selected ? <span aria-hidden="true">✓</span> : null}
      </button>
      <button type="button" className="lab-primary-group-close" aria-label={`Close primary group: ${group.title}`} title={groups.length === 1 ? 'Keep at least one primary group.' : 'Close this group. Agent sessions keep running.'}
        disabled={groups.length === 1} onClick={() => onClose(group.id)}>×</button>
    </div>)}</div>
    <button type="button" className="lab-primary-group-create" aria-label="New primary group" title="New primary group" onClick={onCreate}>+</button>
  </nav>;
}
