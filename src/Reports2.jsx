import { useState } from 'react'
import { SourcePicker, PlacementPicker, ReadOnlyNote, payeeGroups, dollarFormatter, rowKey, SMALL_BTN_STYLE, HINT_STYLE } from './protoCommon'

const CHIP_STYLE = (selected) => ({
  display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
  padding: '5px 8px', marginBottom: '4px', fontSize: '13px', textAlign: 'left',
  border: `1px solid ${selected ? '#90caf9' : '#ddd'}`, borderRadius: '4px',
  background: selected ? '#e3f2fd' : '#fff', cursor: 'pointer', fontFamily: 'inherit',
})

// Prototype A ("payee buckets"): the source category's payees are chips with
// counts and totals; select some and move them into named buckets, each
// becoming a new child or sibling category on save. Unassigned payees stay in
// the source. Operates on the rows in the current date range.
export default function Reports2Tab({ rows, catTree, catOptions, onAddParts, opsEnabled }) {
  const [sourceId, setSourceId] = useState(null)
  const [buckets,  setBuckets]  = useState([])        // { name, placement, payees: Set }
  const [selected, setSelected] = useState(new Set()) // payees picked in the unassigned list

  const source       = sourceId !== null ? catTree.byId.get(sourceId) : undefined
  const parentName   = source && source.parentId !== null ? catTree.byId.get(source.parentId)?.name : null
  const directRows   = source ? rows.filter(r => r._categoryId === sourceId) : []
  const groups       = payeeGroups(directRows)
  const groupByPayee = new Map(groups.map(g => [g.payee, g]))
  const assigned     = new Set(buckets.flatMap(b => [...b.payees]))
  const unassigned   = groups.filter(g => !assigned.has(g.payee))

  const pickSource = (id) => { setSourceId(id); setBuckets([]); setSelected(new Set()) }

  const toggle = (payee) => setSelected(prev => {
    const next = new Set(prev)
    next.has(payee) ? next.delete(payee) : next.add(payee)
    return next
  })

  const updateBucket = (i, patch) =>
    setBuckets(prev => prev.map((b, j) => j === i ? { ...b, ...patch } : b))

  const moveSelectedTo = (i) => {
    setBuckets(prev => prev.map((b, j) => j === i ? { ...b, payees: new Set([...b.payees, ...selected]) } : b))
    setSelected(new Set())
  }

  const removeFromBucket = (i, payee) => {
    const payees = new Set(buckets[i].payees)
    payees.delete(payee)
    updateBucket(i, { payees })
  }

  const bucketTotal = (b) => [...b.payees].reduce((s, p) => s + (groupByPayee.get(p)?.total ?? 0), 0)

  const unnamed = buckets.some(b => b.payees.size > 0 && !b.name.trim())
  const canSave = opsEnabled && !unnamed && buckets.some(b => b.name.trim())

  const save = () => {
    const parts = buckets
      .filter(b => b.name.trim())
      .map(b => ({
        name: b.name.trim(),
        placement: b.placement,
        txKeys: directRows.filter(r => b.payees.has(r['Payee'] || '(no payee)')).map(rowKey),
      }))
    onAddParts(sourceId, parts)
    setBuckets([])
    setSelected(new Set())
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '14px', color: '#2c3e50' }}>Payee buckets</span>
        <SourcePicker catOptions={catOptions} rows={rows} value={sourceId} onChange={pickSource} />
        {source && (
          <button
            onClick={() => setBuckets(prev => [...prev, { name: '', placement: 'child', payees: new Set() }])}
            style={SMALL_BTN_STYLE}
          >
            + New subcategory
          </button>
        )}
        {source && (
          <button
            onClick={save}
            disabled={!canSave}
            style={{ ...SMALL_BTN_STYLE, border: '1px solid #27ae60', background: '#27ae60', color: '#fff', opacity: canSave ? 1 : 0.5 }}
          >
            Save
          </button>
        )}
        <ReadOnlyNote opsEnabled={opsEnabled} />
        {unnamed && <span style={{ fontSize: '12px', color: '#c0392b' }}>name every bucket that has payees</span>}
      </div>

      {!source ? (
        <p style={HINT_STYLE}>Pick a category to see its payees.</p>
      ) : (
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
          <div style={{ width: '300px', flexShrink: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#2c3e50', marginBottom: '6px' }}>
              Payees in {source.name}
              <span style={{ fontWeight: 400, color: '#888', marginLeft: '8px' }}>
                {unassigned.reduce((s, g) => s + g.rows.length, 0)} transactions,{' '}
                {dollarFormatter(unassigned.reduce((s, g) => s + g.total, 0))}
              </span>
            </div>
            {unassigned.map(g => (
              <button key={g.payee} onClick={() => toggle(g.payee)} style={CHIP_STYLE(selected.has(g.payee))}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.payee}</span>
                <span style={{ color: '#888', flexShrink: 0 }}>{g.rows.length}× {dollarFormatter(g.total)}</span>
              </button>
            ))}
            <p style={{ ...HINT_STYLE, fontSize: '12px' }}>
              Whatever stays here remains in {source.name}. Click payees to select them, then move them into a bucket.
            </p>
          </div>

          <div style={{ flex: 1, display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {buckets.length === 0 && (
              <p style={HINT_STYLE}>“+ New subcategory” creates a bucket; selected payees move into it.</p>
            )}
            {buckets.map((b, i) => (
              <div key={i} style={{ width: '260px', background: '#f0f2f5', borderRadius: '6px', padding: '10px' }}>
                <input
                  value={b.name}
                  onChange={e => updateBucket(i, { name: e.target.value })}
                  placeholder="New category name"
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: '13px', fontWeight: 600, padding: '4px 6px', border: '1px solid #ccc', borderRadius: '3px' }}
                />
                <div style={{ margin: '6px 0' }}>
                  <PlacementPicker
                    value={b.placement}
                    onChange={placement => updateBucket(i, { placement })}
                    sourceName={source.name}
                    parentName={parentName}
                  />
                </div>
                <div style={{ fontSize: '12px', color: '#27ae60', fontWeight: 600, marginBottom: '6px' }}>
                  {dollarFormatter(bucketTotal(b))}
                  <span style={{ fontWeight: 400, color: '#999', marginLeft: '6px' }}>{b.payees.size} payees</span>
                  {selected.size > 0 && (
                    <button
                      onClick={() => moveSelectedTo(i)}
                      style={{ marginLeft: '8px', fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #2980b9', borderRadius: '3px', background: '#2980b9', color: '#fff' }}
                    >
                      Move {selected.size} here
                    </button>
                  )}
                </div>
                {[...b.payees].map(p => (
                  <button key={p} onClick={() => removeFromBucket(i, p)} title="Remove from bucket" style={CHIP_STYLE(false)}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</span>
                    <span style={{ color: '#888', flexShrink: 0 }}>
                      {groupByPayee.get(p)?.rows.length ?? 0}× {dollarFormatter(groupByPayee.get(p)?.total ?? 0)} ✕
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
