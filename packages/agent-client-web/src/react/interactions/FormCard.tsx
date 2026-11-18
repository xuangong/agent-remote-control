import { useState, type FormEvent } from 'react';
import type { AgentFormField, AgentFormValues, AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';

type FormRequest = Extract<AgentInteractionRequest, { kind: 'form' }>;
type FormResponse = Extract<AgentInteractionResponse, { kind: 'form' }>;
interface Props {
  request: FormRequest;
  onResponse: (response: FormResponse) => Promise<void>;
  pending: boolean;
  disabled?: boolean;
  failure?: string;
}

export function FormCard({ request, onResponse, pending, disabled = false, failure }: Props) {
  const [draft, setDraft] = useState<Record<string, string | string[]>>(() => Object.fromEntries(request.fields.flatMap((field) =>
    field.defaultValue === undefined
      ? field.required && (field.type === 'text' || field.type === 'multiselect') ? [[field.fieldId, field.type === 'text' ? '' : []]] : []
      : [[field.fieldId, Array.isArray(field.defaultValue) ? field.defaultValue : String(field.defaultValue)]],
  )));
  const [error, setError] = useState<string>();
  function change(fieldId: string, value: string | string[]) {
    setDraft((current) => ({ ...current, [fieldId]: value }));
    setError(undefined);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || disabled) return;
    const values: AgentFormValues = {};
    for (const field of request.fields) {
      const value = draft[field.fieldId];
      if (value === undefined || (value === '' && field.type !== 'text')) {
        if (field.required) { setError(`${field.label} requires a value.`); return; }
        continue;
      }
      if (field.type === 'number') {
        const number = Number(value);
        if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number)) || (field.minimum !== undefined && number < field.minimum) || (field.maximum !== undefined && number > field.maximum)) {
          setError(`${field.label} is outside the allowed range.`); return;
        }
        values[field.fieldId] = number;
      } else if (field.type === 'boolean') values[field.fieldId] = value === 'true';
      else if (field.type === 'multiselect') {
        const selected = Array.isArray(value) ? value : [value];
        if ((field.minItems !== undefined && selected.length < field.minItems) || (field.maxItems !== undefined && selected.length > field.maxItems)) {
          setError(`${field.label} has an invalid number of selections.`); return;
        }
        values[field.fieldId] = selected;
      } else {
        const text = String(value);
        if (field.type === 'text' && ((field.minLength !== undefined && [...text].length < field.minLength) || (field.maxLength !== undefined && [...text].length > field.maxLength))) {
          setError(`${field.label} has an invalid length.`); return;
        }
        values[field.fieldId] = text;
      }
    }
    if (!event.currentTarget.checkValidity()) { event.currentTarget.reportValidity(); return; }
    await onResponse({ kind: 'form', action: 'submit', values });
  }
  return <form className="agent-interaction agent-form" onSubmit={submit} aria-busy={pending}>
    <header><span className="agent-item-kicker">INFORMATION REQUEST</span><h3>{request.title}</h3></header>
    <p>{request.message}</p>
    <fieldset disabled={pending || disabled}>
      {request.fields.map((field) => <FormField key={field.fieldId} field={field} value={draft[field.fieldId]} onChange={(value) => change(field.fieldId, value)} />)}
    </fieldset>
    {error ?? failure ? <p className="agent-form-error" role="alert">{error ?? failure}</p> : null}
    <div className="agent-interaction-actions">
      <button type="submit" disabled={pending || disabled}>{pending ? 'Submitting…' : 'Submit'}</button>
      <button type="button" data-action="decline" disabled={pending || disabled} onClick={() => void onResponse({ kind: 'form', action: 'decline' })}>Decline</button>
      <button type="button" data-action="cancel" disabled={pending || disabled} onClick={() => void onResponse({ kind: 'form', action: 'cancel' })}>Cancel</button>
    </div>
  </form>;
}

function FormField({ field, value, onChange }: { field: AgentFormField; value?: string | string[]; onChange: (value: string | string[]) => void }) {
  const text = typeof value === 'string' ? value : '';
  const common = { name: field.fieldId, required: field.type === 'multiselect' || field.type === 'text' ? false : field.required, 'aria-label': field.label };
  return <label className="agent-form-field">
    <span>{field.label}{field.required ? <small> Required</small> : null}</span>
    {field.type === 'text' ? <input {...common} type={field.sensitive ? 'password' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : 'text'} value={text} placeholder={field.format === 'date-time' ? '2026-09-09T12:00:00Z' : undefined} autoComplete={field.sensitive ? 'off' : undefined} onChange={(event) => onChange(event.target.value)} /> : null}
    {field.type === 'number' ? <input {...common} type="number" value={text} min={field.minimum} max={field.maximum} step={field.integer ? 1 : 'any'} onChange={(event) => onChange(event.target.value)} /> : null}
    {field.type === 'boolean' ? <select {...common} value={text} onChange={(event) => onChange(event.target.value)}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select> : null}
    {field.type === 'select' ? <select {...common} value={text} onChange={(event) => onChange(event.target.value)}><option value="">Choose…</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : null}
    {field.type === 'multiselect' ? <select {...common} multiple value={Array.isArray(value) ? value : []} onChange={(event) => onChange(Array.from(event.target.selectedOptions).map((option) => option.value))}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : null}
    {field.description ? <small>{field.description}</small> : null}
    {field.sensitive ? <small>This answer is hidden in conversation history.</small> : null}
  </label>;
}
