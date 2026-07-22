import { useState, useRef, useEffect, useCallback } from 'react'

const rowKey = r => `${r._txId}/${r._subTxId}`

function parseMoney(val) {
  if (!val) return 0
  return parseFloat(val.replace(/[$,]/g, '')) || 0
}

function netSpend(row) {
  return parseMoney(row['Outflow']) - parseMoney(row['Inflow'])
}

const dollarFormatter = (value) =>
  '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

const SMALL_BTN_STYLE = {
  fontSize: '12px', padding: '2px 10px', cursor: 'pointer',
  border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4',
}

// child/sibling choice for a new subcategory
function PlacementPicker({ value, onChange, sourceName, parentName }) {
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

// Full-width split editor: the source category's transactions are laid out as
// cards in a "staying" column plus one column per new subcategory. Create a
// subcategory (an empty drop target), then move transactions into it by
// dragging cards, or by rubber-band selecting several and using its "Assign"
// button / dragging the selection. Each subcategory chooses child-vs-sibling.
// Save turns the columns into an addCategoryParts op; unassigned cards stay on
// the source. Operates on the rows sitting directly on the source.
let bucketSeq = 0

const cardStyle = (selected) => ({
  padding: '6px 8px', marginBottom: '4px', borderRadius: '4px', fontSize: '12px',
  background: selected ? '#e3f2fd' : '#fff',
  border: `1px solid ${selected ? '#90caf9' : '#ddd'}`,
  cursor: 'grab', userSelect: 'none',
})

const listStyle = (over) => ({
  flex: 1, minHeight: '120px', overflowY: 'auto',
  background: over ? '#eaf3fb' : '#f0f2f5',
  border: `2px dashed ${over ? '#2980b9' : 'transparent'}`,
  borderRadius: '6px', padding: '6px',
})

export default function SplitEditor({ sourceName, parentName, rows, initialSelectedKeys, opsEnabled, onSave, onCancel, onPushUndo }) {
  const [buckets,     setBuckets]     = useState([])  // { id, name, placement }
  const [assignments, setAssignments] = useState({})  // txKey -> bucketId; absent = staying
  const [selected,    setSelected]    = useState(() =>
    new Set([...(initialSelectedKeys ?? [])].filter(k => rows.some(r => rowKey(r) === k))))
  const [marquee,     setMarquee]     = useState(null) // { left, top, width, height } container-local
  const [dragging,    setDragging]    = useState(false)
  const [dragPos,     setDragPos]     = useState(null) // client { x, y } for the floating label
  const [hoverTarget, setHoverTarget] = useState(null) // bucketId | 'stay' | null

  const containerRef  = useRef(null)
  const marqueeStart  = useRef(null) // client { x, y }
  const cardDrag      = useRef(null) // { key, startX, startY, active }
  const bucketsRef    = useRef(buckets);     bucketsRef.current = buckets
  const assignRef     = useRef(assignments); assignRef.current = assignments
  const selectedRef   = useRef(selected);    selectedRef.current = selected
  const hoverRef      = useRef(hoverTarget); hoverRef.current = hoverTarget

  // snapshot current state as one undo entry, pruned when the editor closes
  const snapshot = useCallback(() => {
    const prevB = bucketsRef.current, prevA = assignRef.current
    onPushUndo?.({ scope: 'splitEditor', undo: () => { setBuckets(prevB); setAssignments(prevA) } })
  }, [onPushUndo])

  const assignTo = useCallback((keys, target) => {
    if (keys.length === 0) return
    snapshot()
    setAssignments(prev => {
      const next = { ...prev }
      for (const k of keys) target === 'stay' ? delete next[k] : (next[k] = target)
      return next
    })
    setSelected(new Set())
  }, [snapshot])

  const addBucket = () => {
    snapshot()
    setBuckets(prev => [...prev, { id: ++bucketSeq, name: '', placement: 'child' }])
  }

  const removeBucket = (id) => {
    snapshot()
    setBuckets(prev => prev.filter(b => b.id !== id))
    setAssignments(prev => {
      const next = {}
      for (const [k, v] of Object.entries(prev)) if (v !== id) next[k] = v
      return next
    })
  }

  // document-level move/up: drives both card dragging and the marquee
  useEffect(() => {
    const onMove = (e) => {
      const cd = cardDrag.current
      if (cd) {
        if (!cd.active && Math.hypot(e.clientX - cd.startX, e.clientY - cd.startY) > 4) {
          cd.active = true
          setDragging(true)
          setSelected(prev => prev.has(cd.key) ? prev : new Set([cd.key]))
        }
        if (cd.active) setDragPos({ x: e.clientX, y: e.clientY })
        return
      }
      const s = marqueeStart.current
      if (!s) return
      const box = { left: Math.min(s.x, e.clientX), top: Math.min(s.y, e.clientY), right: Math.max(s.x, e.clientX), bottom: Math.max(s.y, e.clientY) }
      const cont = containerRef.current.getBoundingClientRect()
      setMarquee({ left: box.left - cont.left, top: box.top - cont.top, width: box.right - box.left, height: box.bottom - box.top })
      const hits = new Set()
      containerRef.current.querySelectorAll('[data-txkey]').forEach(el => {
        const r = el.getBoundingClientRect()
        if (r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) hits.add(el.getAttribute('data-txkey'))
      })
      setSelected(hits)
    }
    const onUp = () => {
      const cd = cardDrag.current
      if (cd) {
        cardDrag.current = null
        if (cd.active) {
          if (hoverRef.current !== null) {
            const keys = selectedRef.current.has(cd.key) ? [...selectedRef.current] : [cd.key]
            assignTo(keys, hoverRef.current)
          }
          setDragging(false); setDragPos(null); setHoverTarget(null)
        } else {
          setSelected(prev => {
            const next = new Set(prev)
            next.has(cd.key) ? next.delete(cd.key) : next.add(cd.key)
            return next
          })
        }
        return
      }
      if (marqueeStart.current) { marqueeStart.current = null; setMarquee(null) }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [assignTo])

  const startMarquee = (e) => {
    if (e.button !== 0) return // controls stopPropagation, so this fires from empty space only
    marqueeStart.current = { x: e.clientX, y: e.clientY }
    setSelected(new Set())
    setMarquee(null)
  }

  const byTarget = new Map([['stay', []]])
  for (const b of buckets) byTarget.set(b.id, [])
  for (const r of rows) {
    const t = assignments[rowKey(r)]
    ;(byTarget.get(t !== undefined && byTarget.has(t) ? t : 'stay')).push(r)
  }
  const colTotal = (list) => list.reduce((s, r) => s + netSpend(r), 0)

  const canSave = opsEnabled && buckets.some(b => b.name.trim())
  const save = () => {
    const parts = buckets.filter(b => b.name.trim()).map(b => ({
      name: b.name.trim(), placement: b.placement,
      txKeys: (byTarget.get(b.id) ?? []).map(rowKey),
    }))
    onSave(parts)
  }

  const column = (target, title, subtitle) => {
    const list = byTarget.get(target) ?? []
    const isBucket = target !== 'stay'
    const bucket = isBucket ? buckets.find(b => b.id === target) : null
    const over = dragging && hoverTarget === target
    return (
      <div
        key={target}
        onMouseEnter={() => { if (dragging) setHoverTarget(target) }}
        onMouseLeave={() => setHoverTarget(t => t === target ? null : t)}
        style={{ width: '240px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}
      >
        <div onMouseDown={e => e.stopPropagation()} style={{ marginBottom: '6px' }}>
          {isBucket ? (
            <input
              autoFocus
              value={bucket.name}
              onChange={e => setBuckets(prev => prev.map(b => b.id === target ? { ...b, name: e.target.value } : b))}
              placeholder="New category name"
              style={{ width: '100%', boxSizing: 'border-box', fontSize: '13px', fontWeight: 600, padding: '4px 6px', border: '1px solid #ccc', borderRadius: '3px' }}
            />
          ) : (
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#2c3e50', padding: '4px 2px' }}>{title}</div>
          )}
          {isBucket && (
            <div style={{ margin: '4px 0' }}>
              <PlacementPicker
                value={bucket.placement}
                onChange={placement => setBuckets(prev => prev.map(b => b.id === target ? { ...b, placement } : b))}
                sourceName={sourceName}
                parentName={parentName}
              />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
            <span style={{ fontSize: '12px', color: '#27ae60', fontWeight: 600 }}>
              {dollarFormatter(colTotal(list))}
              <span style={{ fontWeight: 400, color: '#999', marginLeft: '6px' }}>{list.length} tx</span>
            </span>
            {selected.size > 0 && (
              <button
                onClick={() => assignTo([...selected], target)}
                style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #2980b9', borderRadius: '3px', background: '#2980b9', color: '#fff' }}
              >
                Assign {selected.size} here
              </button>
            )}
            {isBucket && (
              <button onClick={() => removeBucket(target)} title="Remove subcategory" style={{ ...SMALL_BTN_STYLE, marginLeft: 'auto', fontSize: '11px' }}>✕</button>
            )}
          </div>
        </div>
        <div style={listStyle(over)}>
          {list.map(r => {
            const key = rowKey(r)
            return (
              <div
                key={key}
                data-txkey={key}
                onMouseDown={e => { e.stopPropagation(); cardDrag.current = { key, startX: e.clientX, startY: e.clientY, active: false } }}
                style={cardStyle(selected.has(key))}
              >
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r['Payee']}</div>
                {r['Memo'] && (
                  <div style={{ fontSize: '11px', color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r['Memo']}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', color: '#888' }}>
                  <span>{r['Date']}</span>
                  <span style={{ fontWeight: 500, color: '#555' }}>{r['Outflow']}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} onMouseDown={startMarquee} style={{ position: 'relative', userSelect: 'none', marginTop: '24px' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '14px', color: '#2c3e50' }}>
          Split: <em style={{ fontWeight: 400 }}>{sourceName}</em>
        </span>
        <button onClick={addBucket} style={SMALL_BTN_STYLE}>+ New subcategory</button>
        <button
          onClick={save}
          disabled={!canSave}
          style={{ ...SMALL_BTN_STYLE, border: '1px solid #27ae60', background: '#27ae60', color: '#fff', opacity: canSave ? 1 : 0.5 }}
        >Save</button>
        <button onClick={onCancel} style={SMALL_BTN_STYLE}>Cancel</button>
        {!opsEnabled && <span style={{ fontSize: '12px', color: '#c0392b' }}>read-only on main — pick a scenario or turn on “Edit live data”</span>}
        <span style={{ fontSize: '12px', color: '#888' }}>
          Drag cards, or drag a box to rubber-band select, then Assign.
        </span>
      </div>

      <div style={{ display: 'flex', gap: '12px', height: '440px', overflowX: 'auto' }}>
        {column('stay', `Staying in ${sourceName}`)}
        {buckets.map(b => column(b.id))}
        {buckets.length === 0 && (
          <div onMouseDown={e => e.stopPropagation()} style={{ alignSelf: 'center', color: '#999', fontSize: '13px', padding: '0 12px' }}>
            “+ New subcategory” makes a drop target; drag transactions into it.
          </div>
        )}
      </div>

      {marquee && (
        <div style={{ position: 'absolute', left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height, background: 'rgba(41,128,185,0.12)', border: '1px solid #2980b9', pointerEvents: 'none', zIndex: 5 }} />
      )}
      {dragging && dragPos && (
        <div style={{ position: 'fixed', left: dragPos.x + 12, top: dragPos.y + 8, background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: '12px', fontWeight: 600, padding: '3px 9px', borderRadius: '20px', pointerEvents: 'none', zIndex: 1000 }}>
          Move {selected.size || 1}
        </div>
      )}
    </div>
  )
}
