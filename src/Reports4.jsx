import { useState, useEffect, useRef } from 'react'
import { SourcePicker, PlacementPicker, ReadOnlyNote, payeeGroups, dollarFormatter, netSpend, rowKey, SMALL_BTN_STYLE, HINT_STYLE } from './protoCommon'

// Prototype C ("triage deck"): the source's payees are dealt one at a time as
// cards (largest first) with sample transactions. Assign each to a bucket
// (click or number key), keep it in the source (k), or make a new bucket on
// the fly; u undoes the last decision. Save applies the buckets as new child
// or sibling categories. Operates on the rows in the current date range.
export default function Reports4Tab({ rows, catTree, catOptions, onAddParts, opsEnabled }) {
  const [sourceId,  setSourceId]  = useState(null)
  const [buckets,   setBuckets]   = useState([]) // { name, placement }
  const [decisions, setDecisions] = useState([]) // ordered { payee, bucketIdx | null } (null = keep in source)
  const [draft,     setDraft]     = useState(null) // { name, placement } | null — the new-bucket form

  const source     = sourceId !== null ? catTree.byId.get(sourceId) : undefined
  const parentName = source && source.parentId !== null ? catTree.byId.get(source.parentId)?.name : null
  const directRows = source ? rows.filter(r => r._categoryId === sourceId) : []
  const groups     = payeeGroups(directRows)
  const decided    = new Set(decisions.map(d => d.payee))
  const queue      = groups.filter(g => !decided.has(g.payee))
  const current    = queue[0]

  const grandTotal    = groups.reduce((s, g) => s + g.total, 0)
  const decidedGroups = groups.filter(g => decided.has(g.payee))
  const decidedTotal  = decidedGroups.reduce((s, g) => s + g.total, 0)

  const bucketStats = buckets.map((b, i) => {
    const payees = decisions.filter(d => d.bucketIdx === i).map(d => d.payee)
    const gs = groups.filter(g => payees.includes(g.payee))
    return { count: gs.reduce((s, g) => s + g.rows.length, 0), total: gs.reduce((s, g) => s + g.total, 0) }
  })

  const pickSource = (id) => { setSourceId(id); setBuckets([]); setDecisions([]); setDraft(null) }

  const decide = (bucketIdx) => {
    if (!current) return
    const payee = current.payee
    setDecisions(prev => [...prev, { payee, bucketIdx }])
  }

  const undo = () => setDecisions(prev => prev.slice(0, -1))

  const createBucketAndAssign = () => {
    const name = draft.name.trim()
    if (!name) return
    const idx = buckets.length
    setBuckets(prev => [...prev, { name, placement: draft.placement }])
    decide(idx)
    setDraft(null)
  }

  const stateRef = useRef({})
  stateRef.current = { buckets, decide, undo }
  useEffect(() => {
    const handler = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const { buckets, decide, undo } = stateRef.current
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= buckets.length) decide(n - 1)
      else if (e.key === 'k') decide(null)
      else if (e.key === 'u') undo()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const save = () => {
    const parts = buckets.map((b, i) => {
      const payees = new Set(decisions.filter(d => d.bucketIdx === i).map(d => d.payee))
      return {
        name: b.name, placement: b.placement,
        txKeys: directRows.filter(r => payees.has(r['Payee'] || '(no payee)')).map(rowKey),
      }
    })
    onAddParts(sourceId, parts)
    setBuckets([])
    setDecisions([])
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '14px', color: '#2c3e50' }}>Triage deck</span>
        <SourcePicker catOptions={catOptions} rows={rows} value={sourceId} onChange={pickSource} />
        {source && (
          <button
            onClick={save}
            disabled={!opsEnabled || buckets.length === 0}
            style={{ ...SMALL_BTN_STYLE, border: '1px solid #27ae60', background: '#27ae60', color: '#fff', opacity: opsEnabled && buckets.length > 0 ? 1 : 0.5 }}
          >
            Save
          </button>
        )}
        {decisions.length > 0 && <button onClick={undo} style={SMALL_BTN_STYLE}>Undo last (u)</button>}
        <ReadOnlyNote opsEnabled={opsEnabled} />
        {source && (
          <span style={{ fontSize: '12px', color: '#888' }}>
            {decidedGroups.length} of {groups.length} payees triaged · {dollarFormatter(decidedTotal)} of {dollarFormatter(grandTotal)}
          </span>
        )}
      </div>

      {!source ? (
        <p style={HINT_STYLE}>Pick a category to triage its payees one by one.</p>
      ) : !current ? (
        <p style={{ fontSize: '14px', color: '#2c3e50' }}>
          {groups.length === 0 ? 'No transactions here in the current date range.' : 'All payees triaged — hit Save.'}
        </p>
      ) : (
        <div style={{ maxWidth: '520px' }}>
          <div style={{ background: '#f0f2f5', borderRadius: '8px', padding: '16px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '8px' }}>
              <span style={{ fontSize: '16px', fontWeight: 600, color: '#2c3e50' }}>{current.payee}</span>
              <span style={{ fontSize: '13px', color: '#888' }}>{current.rows.length}× · {dollarFormatter(current.total)}</span>
            </div>
            {current.rows.slice(0, 6).map(r => (
              <div key={rowKey(r)} style={{ display: 'flex', gap: '10px', fontSize: '12px', padding: '3px 0', color: '#555' }}>
                <span style={{ color: '#888', flexShrink: 0 }}>{r['Date']}</span>
                <span style={{ color: '#999', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r['Memo']}</span>
                <span style={{ flexShrink: 0 }}>{dollarFormatter(netSpend(r))}</span>
              </div>
            ))}
            {current.rows.length > 6 && (
              <div style={{ fontSize: '12px', color: '#999' }}>… and {current.rows.length - 6} more</div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {buckets.map((b, i) => (
              <button
                key={i}
                onClick={() => decide(i)}
                style={{ ...SMALL_BTN_STYLE, fontSize: '13px', padding: '5px 12px' }}
              >
                {b.name}
                <span style={{ color: '#888', marginLeft: '6px' }}>
                  ({i + 1}) {bucketStats[i].count}× {dollarFormatter(bucketStats[i].total)}
                </span>
              </button>
            ))}
            <button onClick={() => decide(null)} style={{ ...SMALL_BTN_STYLE, fontSize: '13px', padding: '5px 12px' }}>
              Keep in {source.name} <span style={{ color: '#888' }}>(k)</span>
            </button>
            {draft === null ? (
              <button onClick={() => setDraft({ name: '', placement: 'child' })} style={{ ...SMALL_BTN_STYLE, fontSize: '13px', padding: '5px 12px' }}>
                + New bucket
              </button>
            ) : (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <input
                  autoFocus
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') createBucketAndAssign()
                    if (e.key === 'Escape') setDraft(null)
                  }}
                  placeholder="New category name"
                  style={{ fontSize: '13px', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', width: '160px' }}
                />
                <PlacementPicker
                  value={draft.placement}
                  onChange={placement => setDraft(d => ({ ...d, placement }))}
                  sourceName={source.name}
                  parentName={parentName}
                />
                <button
                  onClick={createBucketAndAssign}
                  disabled={!draft.name.trim()}
                  style={{ ...SMALL_BTN_STYLE, border: '1px solid #2980b9', background: '#2980b9', color: '#fff', opacity: draft.name.trim() ? 1 : 0.5 }}
                >
                  Create &amp; assign
                </button>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
