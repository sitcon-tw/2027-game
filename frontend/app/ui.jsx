import { useId } from 'react';

const glyphs = {
  brand: 'M12 2 15 9 22 12 15 15 12 22 9 15 2 12 9 9Z',
  overview: 'M3.5 3.5h7v7h-7z M13.5 3.5h7v7h-7z M3.5 13.5h7v7h-7z M13.5 13.5h7v7h-7z',
  event: 'M6 3v4m12-4v4M4 9h16M4 5h16v15H4z M8 13h3m2 0h3m-8 3h3',
  players: 'M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-4M9.5 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm6.5.1a3.5 3.5 0 0 1 0 6.8',
  stations: 'M3 10l2-6h14l2 6M3 10h18m-17 0v10h16V10m-10 10v-6h4v6',
  checkpoints: 'M12 22s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12zm0-15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  audit: 'M7 3h8l4 4v14H5V3h2zm7 0v5h5M9 12h6m-6 4h6',
  refresh: 'M20 9a8 8 0 1 0 0 6m0-11v5h-5',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  packs: 'M4 7l8-4 8 4v10l-8 4-8-4V7zm0 0 8 4 8-4m-8 4v10',
  alert: 'M12 3 2 20h20L12 3zm0 6v5m0 3h.01',
  complete: 'm5 12 5 5 9-10',
};

export function Icon({ name }) {
  return <svg className="icon" viewBox="0 0 24 24" fill={name === 'brand' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyphs[name]} /></svg>;
}

export function Card({ title, action, children }) {
  const id = useId();
  return <section className="card" aria-labelledby={id}><div className="section-heading"><h2 id={id}>{title}</h2>{action}</div>{children}</section>;
}

export function Field({ id, label, help, children }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{help ? <small id={`${id}-help`}>{help}</small> : null}</div>;
}

export function NumberField({ id, name, label, min, max, ...input }) {
  return (
    <Field id={id} label={label}>
      <input id={id} name={name} type="number" inputMode="numeric" min={min} max={max} step="1" required {...input} />
    </Field>
  );
}

export function ChoiceGroup({ name, label, choices, value, onChange, hint, controls }) {
  const prefix = useId();
  return (
    <fieldset className="choice-field" aria-describedby={hint ? `${prefix}-hint` : undefined}>
      <legend>{label}</legend>
      <div className="choices">
        {Object.entries(choices).map(([key, text]) => (
          <div className="choice" key={key}>
            <input id={`${prefix}-${key}`} type="radio" name={name} value={key} checked={value === key} onChange={() => onChange(key)} required aria-controls={controls?.[key]} />
            <label htmlFor={`${prefix}-${key}`}>{text}</label>
          </div>
        ))}
      </div>
      {hint ? <p id={`${prefix}-hint`} className="hint">{hint}</p> : null}
    </fieldset>
  );
}

export function DataTable({ caption, headings, rows, sort, empty = '目前沒有資料' }) {
  const id = useId();
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={id}>
      <table>
        <caption id={id} className="sr-only">{caption}</caption>
        <thead><tr>{headings.map((label, index) => (
          <th key={label} scope="col" aria-sort={sort?.column === index ? sort.direction : undefined}>
            {sort ? <button type="button" className="table-sort" onClick={() => sort.onChange(index)}>
              {label}<span aria-hidden="true" />
            </button> : label}
          </th>
        ))}</tr></thead>
        <tbody>
          {rows.length ? rows.map(([key, first, ...cells]) => (
            <tr key={key}>
              <th scope="row">{first ?? '—'}</th>
              {cells.map((cell, index) => <td key={headings[index + 1]}>{cell ?? '—'}</td>)}
            </tr>
          )) : <tr><td colSpan={headings.length} className="empty">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
