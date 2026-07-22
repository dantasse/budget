import { useState } from 'react'
import { SourcePicker, PlacementPicker, ReadOnlyNote, payeeGroups, dollarFormatter, netSpend, rowKey, SMALL_BTN_STYLE, HINT_STYLE } from './protoCommon'

// Prototype B ("search & carve"): type a query against payee/memo of the
// source's remaining transactions, watch the live match list and total, then
// carve the matches out into a named child or sibling category. Repeat until
// the remainder looks right; Save applies all carves at once. Operates on the
// rows in the current date range.
export default function Reports3Tab({ rows, catTree, catOptions, onAddParts, opsEnabled }) {
  const [sourceId,  setSourceId]  = useState(null)
  const [query,     setQuery]     = useState('')
  const [name,      setName]      = useState('')
  const [placement, setPlacement] = useState('child')
  const [carves,    setCarves]    = useState([]) // { name, placement, txKeys, count, total }

  const source     = sourceId !== null ? catTree.byId.get(sourceId) : undefined
  const parentName = source && source.parentId !== null ? catTree.byId.get(source.parentId)?.name : null
  const directRows = source ? rows.filter(r => r._categoryId === sourceId) : []
  const carvedKeys = new Set(carves.flatMap(c => c.txKeys))
  const remaining  = directRows.filter(r => !carvedKeys.has(rowKey(r)))
  const remainingGroups = payeeGroups(remaining)

  const q = query.trim().toLowerCase()
  const matches = q
    ? remaining.filter(r =>
        (r['Payee'] ?? '').toLowerCase().includes(q) || (r['Memo'] ?? '').toLowerCase().includes(q))
    : []
  const matchTotal = matches.reduce((s, r) => s + netSpend(r), 0)

  const pickSource = (id) => { setSourceId(id); setQuery(''); setName(''); setCarves([]) }

  const carveOut = () => {
    setCarves(prev => [...prev, {
      name: name.trim(), placement,
      txKeys: matches.map(rowKey), count: matches.length, total: matchTotal,
    }])
    setQuery('')
    setName('')
    setPlacement('child')
  }

  const save = () => {
    onAddParts(sourceId, carves.map(({ name, placement, txKeys }) => ({ name, placement, txKeys })))
    setCarves([])
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '14px', color: '#2c3e50' }}>Search &amp; carve</span>
        <SourcePicker catOptions={catOptions} rows={rows} value={sourceId} onChange={pickSource} />
        {source && (
          <button
            onClick={save}
            disabled={!opsEnabled || carves.length === 0}
            style={{ ...SMALL_BTN_STYLE, border: '1px solid #27ae60', background: '#27ae60', color: '#fff', opacity: opsEnabled && carves.length > 0 ? 1 : 0.5 }}
          >
            Save
          </button>
        )}
        <ReadOnlyNote opsEnabled={opsEnabled} />
      </div>

      {!source ? (
        <p style={HINT_STYLE}>Pick a category to carve pieces out of it.</p>
      ) : (
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
          <div style={{ width: '260px', flexShrink: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#2c3e50', marginBottom: '6px' }}>
              Still in {source.name}
              <span style={{ fontWeight: 400, color: '#888', marginLeft: '8px' }}>
                {remaining.length} transactions, {dollarFormatter(remaining.reduce((s, r) => s + netSpend(r), 0))}
              </span>
            </div>
            {remainingGroups.map(g => (
              <button
                key={g.payee}
                onClick={() => setQuery(g.payee)}
                title="Search for this payee"
                style={{ display: 'flex', gap: '8px', width: '100%', padding: '4px 8px', marginBottom: '3px', fontSize: '12px', textAlign: 'left', border: '1px solid #ddd', borderRadius: '4px', background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.payee}</span>
                <span style={{ color: '#888', flexShrink: 0 }}>{g.rows.length}× {dollarFormatter(g.total)}</span>
              </button>
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 0, maxWidth: '560px' }}>
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search payee or memo…"
              style={{ width: '100%', boxSizing: 'border-box', fontSize: '14px', padding: '6px 10px', border: '1px solid #ccc', borderRadius: '4px' }}
            />
            <div style={{ fontSize: '12px', color: '#888', margin: '6px 0' }}>
              {q
                ? `${matches.length} transactions match, ${dollarFormatter(matchTotal)}`
                : 'Matches show here; a payee click on the left fills the search.'}
            </div>
            <div style={{ maxHeight: '320px', overflowY: 'auto', marginBottom: '10px' }}>
              {matches.map(r => (
                <div key={rowKey(r)} style={{ display: 'flex', gap: '10px', fontSize: '12px', padding: '4px 8px', borderBottom: '1px solid #eee' }}>
                  <span style={{ color: '#888', flexShrink: 0 }}>{r['Date']}</span>
                  <span style={{ fontWeight: 500, flexShrink: 0 }}>{r['Payee']}</span>
                  <span style={{ color: '#999', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r['Memo']}</span>
                  <span style={{ flexShrink: 0 }}>{dollarFormatter(netSpend(r))}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="New category name"
                style={{ fontSize: '13px', padding: '5px 8px', border: '1px solid #ccc', borderRadius: '4px', width: '180px' }}
              />
              <PlacementPicker value={placement} onChange={setPlacement} sourceName={source.name} parentName={parentName} />
              <button
                onClick={carveOut}
                disabled={!name.trim() || matches.length === 0}
                style={{ ...SMALL_BTN_STYLE, border: '1px solid #2980b9', background: '#2980b9', color: '#fff', opacity: name.trim() && matches.length > 0 ? 1 : 0.5 }}
              >
                Carve out
              </button>
            </div>
          </div>

          <div style={{ width: '260px', flexShrink: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#2c3e50', marginBottom: '6px' }}>Carved out (unsaved)</div>
            {carves.length === 0 && <p style={{ ...HINT_STYLE, fontSize: '12px' }}>Nothing carved yet.</p>}
            {carves.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '5px 8px', marginBottom: '4px', background: '#f0f2f5', borderRadius: '4px' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong>{c.name}</strong> <span style={{ color: '#888' }}>({c.placement})</span>
                </span>
                <span style={{ color: '#888', flexShrink: 0 }}>{c.count}× {dollarFormatter(c.total)}</span>
                <button
                  onClick={() => setCarves(prev => prev.filter((_, j) => j !== i))}
                  title="Undo this carve"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c0392b', padding: 0 }}
                >✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
