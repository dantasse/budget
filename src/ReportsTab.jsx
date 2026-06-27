import { useMemo, useState, useEffect, useCallback, Fragment } from 'react'
import { Treemap, ResponsiveContainer, Tooltip } from 'recharts'

function parseMoney(val) {
  if (!val) return 0
  return parseFloat(val.replace(/[$,]/g, '')) || 0
}

const COLORS = [
  '#2c3e50', '#2980b9', '#27ae60', '#8e44ad', '#e67e22',
  '#c0392b', '#16a085', '#d35400', '#7f8c8d', '#f39c12',
  '#1abc9c', '#e74c3c', '#3498db', '#9b59b6', '#2ecc71',
]

const dollarFormatter = (value) =>
  '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const { name, value } = payload[0].payload
  return (
    <div style={{
      background: '#fff', border: '1px solid #ddd', borderRadius: '6px',
      padding: '10px 14px', fontSize: '13px', boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '4px' }}>{name}</div>
      <div>{dollarFormatter(value)}</div>
    </div>
  )
}

function isRowSelected(row, selectedGroups) {
  if (!selectedGroups) return true
  const group = row['Category Group']
  const cat   = row['Category']
  if (selectedGroups.has(`group:${group}`)) return true
  if (cat && selectedGroups.has(`cat:${group}:${cat}`)) return true
  return false
}

export default function ReportsTab({ rows, selectedGroups, budgetId }) {
  const hiddenKey = `ynab_report_hidden_${budgetId}`
  const mergesKey = `ynab_report_merges_${budgetId}`

  const [hiddenNames, setHiddenNames] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(hiddenKey)) ?? []) }
    catch { return new Set() }
  })
  // merges: Map<childName, parentName> — purely display-level, no data changes
  const [merges, setMerges] = useState(() => {
    try { return new Map(JSON.parse(localStorage.getItem(mergesKey)) ?? []) }
    catch { return new Map() }
  })
  // mergeOrder: insertion order for Cmd+Z (not persisted)
  const [mergeOrder,  setMergeOrder]  = useState([])
  const [dragging,         setDragging]         = useState(null)
  const [dropTarget,       setDropTarget]       = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)

  useEffect(() => {
    localStorage.setItem(hiddenKey, JSON.stringify([...hiddenNames]))
  }, [hiddenNames, hiddenKey])

  useEffect(() => {
    localStorage.setItem(mergesKey, JSON.stringify([...merges]))
  }, [merges, mergesKey])

  useEffect(() => {
    if (!dragging) return
    const cancel = () => { setDragging(null); setDropTarget(null) }
    document.addEventListener('mouseup', cancel)
    return () => document.removeEventListener('mouseup', cancel)
  }, [dragging])

  useEffect(() => {
    document.body.style.cursor = dragging ? 'grabbing' : ''
    return () => { document.body.style.cursor = '' }
  }, [dragging])

  const handleMerge = useCallback((fromName, toName) => {
    setMerges(prev => new Map(prev).set(fromName, toName))
    setMergeOrder(prev => [...prev.filter(n => n !== fromName), fromName])
  }, [])

  const applyUngroup = useCallback((childName) => {
    setMerges(prev => { const next = new Map(prev); next.delete(childName); return next })
    setMergeOrder(prev => prev.filter(n => n !== childName))
  }, [])

  const handleUndo = useCallback(() => {
    if (mergeOrder.length === 0) return
    applyUngroup(mergeOrder[mergeOrder.length - 1])
  }, [mergeOrder, applyUngroup])

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleUndo])

  const labelFor = useCallback((row) => {
    if (!isRowSelected(row, selectedGroups)) return null
    const group = row['Category Group']
    const cat   = row['Category']
    return selectedGroups?.has(`group:${group}`) ? group : (cat || group)
  }, [selectedGroups])

  // allData: child spending is rolled up into the parent
  const allData = useMemo(() => {
    const totals = new Map()
    for (const row of rows) {
      const label = labelFor(row)
      if (!label) continue
      const outflow = parseMoney(row['Outflow'])
      if (outflow === 0) continue
      const target = merges.get(label) ?? label
      totals.set(target, (totals.get(target) ?? 0) + outflow)
    }
    return [...totals.entries()]
      .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value)
  }, [rows, labelFor, merges])

  // childTotals: per-child spending for the table breakdown
  const childTotals = useMemo(() => {
    const totals = new Map()
    for (const row of rows) {
      const label = labelFor(row)
      if (!label || !merges.has(label)) continue
      const outflow = parseMoney(row['Outflow'])
      if (outflow === 0) continue
      totals.set(label, (totals.get(label) ?? 0) + outflow)
    }
    return totals
  }, [rows, labelFor, merges])

  // parentName → [childName, ...]
  const childrenOf = useMemo(() => {
    const map = new Map()
    for (const [child, parent] of merges) {
      if (!map.has(parent)) map.set(parent, [])
      map.get(parent).push(child)
    }
    return map
  }, [merges])

  const filteredRows = useMemo(() => {
    if (!selectedCategory) return []
    return rows.filter(r => {
      const label = labelFor(r)
      if (!label) return false
      return (merges.get(label) ?? label) === selectedCategory
    })
  }, [selectedCategory, rows, labelFor, merges])

  // Preserve colorIndex from allData so colors are stable when items are hidden
  const data = allData
    .map((d, i) => ({ ...d, colorIndex: i }))
    .filter(d => !hiddenNames.has(d.name))

  const renderCell = ({ x, y, width, height, name, value, colorIndex }) => {
    if (!width || !height || width < 2 || height < 2) return null
    const isDraggingThis = dragging === name
    const isTarget       = dropTarget === name && dragging && dragging !== name
    const color          = COLORS[colorIndex % COLORS.length]
    const showText       = width > 50  && height > 24
    const showValue      = width > 70  && height > 44
    return (
      <g
        style={{ cursor: dragging ? (isDraggingThis ? 'grabbing' : 'copy') : 'grab', userSelect: 'none' }}
        onMouseDown={e => { e.preventDefault(); setDragging(name) }}
        onMouseEnter={() => { if (dragging && dragging !== name) setDropTarget(name) }}
        onMouseLeave={() => { if (dropTarget === name) setDropTarget(null) }}
        onMouseUp={() => {
          if (dragging && dragging !== name) {
            handleMerge(dragging, name)
            setDragging(null)
            setDropTarget(null)
          } else if (dragging === name) {
            setSelectedCategory(prev => prev === name ? null : name)
            setDragging(null)
          }
        }}
      >
        <rect x={x} y={y} width={width} height={height} fill={color} stroke="#fff" strokeWidth={isTarget ? 3 : 2} opacity={isDraggingThis ? 0.35 : 1} />
        {isTarget && <rect x={x+3} y={y+3} width={width-6} height={height-6} fill="none" stroke="#fff" strokeWidth={2} strokeDasharray="5 3" />}
        {showText && !isDraggingThis && (
          <text x={x + width/2} y={y + height/2 + (showValue ? -7 : 4)} textAnchor="middle" fill="#fff" fontSize={12} fontWeight={600} style={{ pointerEvents: 'none' }}>
            {name}
          </text>
        )}
        {showValue && !isDraggingThis && (
          <text x={x + width/2} y={y + height/2 + 10} textAnchor="middle" fill="#fff" fontSize={11} opacity={0.85} style={{ pointerEvents: 'none' }}>
            {dollarFormatter(value)}
          </text>
        )}
      </g>
    )
  }

  const toggleHidden = (name) =>
    setHiddenNames(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })

  if (rows.length === 0) return (
    <div style={{ color: '#555', padding: '24px 0' }}>No data loaded.</div>
  )

  const total = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <div>
      <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '16px', fontSize: '14px', color: '#555' }}>
        <span>Total spending: <strong style={{ color: '#2c3e50' }}>{dollarFormatter(total)}</strong>{' '}across <strong>{data.length}</strong> categories</span>
        {mergeOrder.length > 0 && (
          <button onClick={handleUndo} style={{ fontSize: '12px', padding: '2px 10px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4' }}>
            Undo merge (⌘Z)
          </button>
        )}
        {dragging && (
          <span style={{ color: '#888', fontStyle: 'italic' }}>Drop onto another category to merge</span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={420}>
        <Treemap data={data} dataKey="value" content={renderCell} isAnimationActive={false}>
          <Tooltip content={<CustomTooltip />} />
        </Treemap>
      </ResponsiveContainer>

      <table style={{ fontSize: '13px', borderCollapse: 'collapse', marginTop: '24px', width: '100%', maxWidth: '560px' }}>
        <thead>
          <tr style={{ background: '#2c3e50', color: '#fff' }}>
            <th style={{ padding: '8px 12px', textAlign: 'left' }}>Category</th>
            <th style={{ padding: '8px 12px', textAlign: 'right' }}>Spending</th>
            <th style={{ padding: '8px 12px', textAlign: 'right' }}>Share</th>
            <th style={{ padding: '8px 12px' }} />
          </tr>
        </thead>
        <tbody>
          {allData.map(({ name, value }, i) => {
            const hidden   = hiddenNames.has(name)
            const children = childrenOf.get(name) ?? []
            return (
              <Fragment key={name}>
                <tr style={{ background: hidden ? '#f0f0f0' : (i % 2 === 0 ? '#fff' : '#f4f6f8') }}>
                  <td style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px', opacity: hidden ? 0.4 : 1 }}>
                    <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                    {name}
                  </td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', opacity: hidden ? 0.4 : 1 }}>{dollarFormatter(value)}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', color: '#777', opacity: hidden ? 0.4 : 1 }}>
                    {hidden ? '—' : `${((value / total) * 100).toFixed(1)}%`}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                    <button
                      onClick={() => toggleHidden(name)}
                      style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}
                    >
                      {hidden ? 'show' : 'hide'}
                    </button>
                  </td>
                </tr>
                {children.map(childName => {
                  const spend = childTotals.get(childName) ?? 0
                  return (
                    <tr key={childName} style={{ background: hidden ? '#f0f0f0' : (i % 2 === 0 ? '#f8f8f8' : '#efefef'), opacity: hidden ? 0.4 : 1 }}>
                      <td style={{ padding: '4px 12px 4px 28px', display: 'flex', alignItems: 'center', gap: '8px', color: '#555' }}>
                        <span style={{ color: '#bbb' }}>—</span>
                        {childName}
                      </td>
                      <td style={{ padding: '4px 12px', textAlign: 'right', color: '#555' }}>{dollarFormatter(spend)}</td>
                      <td style={{ padding: '4px 12px', textAlign: 'right', color: '#999' }}>
                        {((spend / total) * 100).toFixed(1)}%
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                        <button
                          onClick={() => applyUngroup(childName)}
                          style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}
                        >
                          ungroup
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      {selectedCategory && (
        <div style={{ marginTop: '32px' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '8px', color: '#2c3e50' }}>
            {selectedCategory}
            <button onClick={() => setSelectedCategory(null)} style={{ marginLeft: '12px', fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}>✕</button>
          </div>
          <table style={{ fontSize: '13px', borderCollapse: 'collapse', width: '100%', maxWidth: '860px' }}>
            <thead>
              <tr style={{ background: '#2c3e50', color: '#fff' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left' }}>Date</th>
                <th style={{ padding: '8px 12px', textAlign: 'left' }}>Payee</th>
                <th style={{ padding: '8px 12px', textAlign: 'left' }}>Category</th>
                <th style={{ padding: '8px 12px', textAlign: 'left' }}>Memo</th>
                <th style={{ padding: '8px 12px', textAlign: 'right' }}>Outflow</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, i) => (
                <tr key={`${r._txId}/${r._subTxId}`} style={{ background: i % 2 === 0 ? '#fff' : '#f4f6f8' }}>
                  <td style={{ padding: '5px 12px' }}>{r['Date']}</td>
                  <td style={{ padding: '5px 12px' }}>{r['Payee']}</td>
                  <td style={{ padding: '5px 12px', color: '#555' }}>{r['Category'] || r['Category Group']}</td>
                  <td style={{ padding: '5px 12px', color: '#777' }}>{r['Memo']}</td>
                  <td style={{ padding: '5px 12px', textAlign: 'right' }}>{parseMoney(r['Outflow']) > 0 ? dollarFormatter(parseMoney(r['Outflow'])) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
