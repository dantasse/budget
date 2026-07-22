import { useMemo } from 'react'

// Shared pieces for the Reports2/3/4 split-interaction prototypes.

export const rowKey = r => `${r._txId}/${r._subTxId}`

export function parseMoney(val) {
  if (!val) return 0
  return parseFloat(val.replace(/[$,]/g, '')) || 0
}

export function netSpend(row) {
  return parseMoney(row['Outflow']) - parseMoney(row['Inflow'])
}

export const dollarFormatter = (value) =>
  '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

export const SMALL_BTN_STYLE = {
  fontSize: '12px', padding: '2px 10px', cursor: 'pointer',
  border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4',
}

export const HINT_STYLE = { fontSize: '13px', color: '#777' }

// rows grouped by payee, largest net spend first
export function payeeGroups(rows) {
  const m = new Map()
  for (const r of rows) {
    const payee = r['Payee'] || '(no payee)'
    if (!m.has(payee)) m.set(payee, { payee, rows: [], total: 0 })
    const g = m.get(payee)
    g.rows.push(r)
    g.total += netSpend(r)
  }
  return [...m.values()].sort((a, b) => b.total - a.total)
}

// dropdown over the whole tree; nodes with transactions directly on them show a count
export function SourcePicker({ catOptions, rows, value, onChange }) {
  const directCounts = useMemo(() => {
    const m = new Map()
    for (const r of rows) m.set(r._categoryId, (m.get(r._categoryId) ?? 0) + 1)
    return m
  }, [rows])
  return (
    <select
      title="source category"
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      style={{ padding: '4px 8px', fontSize: '13px', maxWidth: '340px' }}
    >
      <option value="">— Category to split —</option>
      {catOptions.map(o => (
        <option key={o.id} value={o.id}>
          {'   '.repeat(o.depth) + o.name + (directCounts.has(o.id) ? ` (${directCounts.get(o.id)})` : '')}
        </option>
      ))}
    </select>
  )
}

// child/sibling choice for a new part
export function PlacementPicker({ value, onChange, sourceName, parentName }) {
  const radio = (val, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: '3px', cursor: 'pointer' }}>
      <input type="radio" checked={value === val} onChange={() => onChange(val)} style={{ cursor: 'pointer' }} />
      {label}
    </label>
  )
  return (
    <span style={{ display: 'inline-flex', gap: '10px', fontSize: '12px', color: '#555' }}>
      {radio('child', `child of ${sourceName}`)}
      {radio('sibling', `sibling (${parentName ? `under ${parentName}` : 'top level'})`)}
    </span>
  )
}

// grayed note + save gating when ops are disallowed (main without "Edit live data")
export function ReadOnlyNote({ opsEnabled }) {
  if (opsEnabled) return null
  return (
    <span style={{ fontSize: '12px', color: '#c0392b' }}>
      read-only on main — pick a scenario or turn on “Edit live data”
    </span>
  )
}
