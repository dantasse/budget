import { useMemo, useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { Treemap, ResponsiveContainer, Tooltip } from 'recharts'
import TransactionsTab from './TransactionsTab'

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

function tokenize(str) {
  return (str ?? '').toLowerCase().split(/[\W_]+/).filter(w => w.length > 1)
}

// Classifies non-manual rows using manual examples as training data.
// Fast path: exact payee match → majority class among same-payee manual examples.
// Fallback: Naive Bayes on payee tokens with a pseudocount prior so it works
// from the very first drag (no requirement for examples in every class).
function classifyAll(rows, assignments, manualKeys, numParts) {
  if (manualKeys.size === 0) return null
  const classDocs = Array.from({ length: numParts }, () => ({ words: {}, total: 0, n: 0 }))
  const payeeTally = new Map() // payee_lower → count per class
  for (const row of rows) {
    const key = `${row._txId}/${row._subTxId}`
    if (!manualKeys.has(key)) continue
    const ci = assignments[key] ?? 0
    const payee = (row['Payee'] ?? '').trim().toLowerCase()
    if (!payeeTally.has(payee)) payeeTally.set(payee, Array(numParts).fill(0))
    payeeTally.get(payee)[ci]++
    classDocs[ci].n++
    for (const w of tokenize(row['Payee'])) {
      classDocs[ci].words[w] = (classDocs[ci].words[w] ?? 0) + 1
      classDocs[ci].total++
    }
  }
  const totalManual = classDocs.reduce((s, d) => s + d.n, 0)
  const vocab = new Set(classDocs.flatMap(d => Object.keys(d.words)))
  const vocabSize = vocab.size || 1
  // pseudocount of 0.5 per class so NB works even when some classes have 0 examples
  const pseudo = 0.5
  const next = { ...assignments }
  for (const row of rows) {
    const key = `${row._txId}/${row._subTxId}`
    if (manualKeys.has(key)) continue
    const payee = (row['Payee'] ?? '').trim().toLowerCase()
    const tally = payeeTally.get(payee)
    if (tally) {
      // exact payee match: assign to whichever class has the most manual examples
      next[key] = tally.indexOf(Math.max(...tally))
      continue
    }
    const words = tokenize(row['Payee'])
    const scores = classDocs.map(d => {
      let s = Math.log((d.n + pseudo) / (totalManual + pseudo * numParts))
      for (const w of words) s += Math.log(((d.words[w] ?? 0) + 1) / (d.total + vocabSize))
      return s
    })
    next[key] = scores.indexOf(Math.max(...scores))
  }
  return next
}

export default function ReportsTab({ rows, selectedGroups, budgetId, categoryGroups, onUpdateCategory, onBulkUpdateCategory, onUpdateMemo, isMainScenario, onRenameGroup }) {
  const hiddenKey = `ynab_report_hidden_${budgetId}`
  const mergesKey = `ynab_report_merges_${budgetId}`
  const splitsKey = `ynab_report_splits_${budgetId}`

  const [hiddenNames, setHiddenNames] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(hiddenKey)) ?? []) }
    catch { return new Set() }
  })
  // merges: Map<childName, parentName> — purely display-level, no data changes
  const [merges, setMerges] = useState(() => {
    try { return new Map(JSON.parse(localStorage.getItem(mergesKey)) ?? []) }
    catch { return new Map() }
  })
  // splits: Map<catName, {parts, assignments, manualKeys}>
  // assignments: {[txKey]: partIndex}; manualKeys: string[] (serialized Set)
  const [splits, setSplits] = useState(() => {
    try { return new Map(JSON.parse(localStorage.getItem(splitsKey)) ?? []) }
    catch { return new Map() }
  })
  // mergeOrder: insertion order for Cmd+Z (not persisted)
  const [mergeOrder,       setMergeOrder]       = useState([])
  const [dragging,         setDragging]         = useState(null)
  const [dropTarget,       setDropTarget]       = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [editingGroup,     setEditingGroup]     = useState(null) // { name, value } | null
  const [contextMenu,      setContextMenu]      = useState(null) // { x, y, name } | null
  // editingSplit: { catName, parts: string[], assignments: {[txKey]: number}, manualKeys: Set<string> } | null
  const [editingSplit,     setEditingSplit]     = useState(null)
  const [groupPositions,   setGroupPositions]   = useState({})
  const svgWrapperRef = useRef(null)

  useEffect(() => {
    localStorage.setItem(hiddenKey, JSON.stringify([...hiddenNames]))
  }, [hiddenNames, hiddenKey])

  useEffect(() => {
    localStorage.setItem(mergesKey, JSON.stringify([...merges]))
  }, [merges, mergesKey])

  useEffect(() => {
    localStorage.setItem(splitsKey, JSON.stringify([...splits]))
  }, [splits, splitsKey])

  useEffect(() => {
    const el = svgWrapperRef.current
    if (!el) return
    const read = () => {
      const next = {}
      el.querySelectorAll('[data-group-name]').forEach(rect => {
        const x = parseFloat(rect.getAttribute('x'))
        const y = parseFloat(rect.getAttribute('y'))
        const width = parseFloat(rect.getAttribute('width'))
        const height = parseFloat(rect.getAttribute('height'))
        if (width > 2 && height > 2) next[rect.getAttribute('data-group-name')] = { x, y, width, height }
      })
      setGroupPositions(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
    }
    const mo = new MutationObserver(read)
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['x', 'y', 'width', 'height', 'data-group-name'] })
    read()
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const dismiss = () => setContextMenu(null)
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [contextMenu])

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

  const twoLevelData = useMemo(() => {
    const groupMap = new Map()
    // tracks which display-level cat names were produced by a split (effectiveName → originalName)
    const splitOrigins = new Map()
    for (const row of rows) {
      if (!isRowSelected(row, selectedGroups)) continue
      const outflow = parseMoney(row['Outflow'])
      if (outflow === 0) continue
      const group = row['Category Group'] || '(none)'
      const cat   = row['Category'] || group
      if (hiddenNames.has(cat)) continue
      const splitDef = splits.get(cat)
      let effectiveCat = cat
      if (splitDef?.parts?.length >= 2) {
        const key = `${row._txId}/${row._subTxId}`
        const idx = splitDef.assignments[key] ?? 0
        effectiveCat = splitDef.parts[idx] ?? splitDef.parts[0]
        splitOrigins.set(effectiveCat, cat)
      }
      if (!groupMap.has(group)) groupMap.set(group, new Map())
      groupMap.get(group).set(effectiveCat, (groupMap.get(group).get(effectiveCat) ?? 0) + outflow)
    }
    return [...groupMap.entries()]
      .map(([gName, catMap], gi) => ({
        name: gName,
        groupColorIndex: gi,
        children: [...catMap.entries()]
          .map(([cName, value]) => ({
            name: cName,
            value: Math.round(value * 100) / 100,
            groupColorIndex: gi,
            _splitFrom: splitOrigins.get(cName),
          }))
          .sort((a, b) => b.value - a.value),
      }))
      .filter(g => g.children.length > 0)
      .sort((a, b) => {
        const aSum = a.children.reduce((s, c) => s + c.value, 0)
        const bSum = b.children.reduce((s, c) => s + c.value, 0)
        return bSum - aSum
      })
  }, [rows, selectedGroups, hiddenNames, splits])

  const filteredRows = useMemo(() => {
    if (!selectedCategory) return []
    return rows.filter(r => {
      if (!isRowSelected(r, selectedGroups)) return false
      return (r['Category'] || r['Category Group']) === selectedCategory
    })
  }, [selectedCategory, rows, selectedGroups])

  const splitEditorRows = useMemo(() => {
    if (!editingSplit) return []
    return rows.filter(r => {
      if (!isRowSelected(r, selectedGroups)) return false
      return (r['Category'] || r['Category Group']) === editingSplit.catName
    })
  }, [editingSplit?.catName, rows, selectedGroups])

  // per-part spending totals, recomputed as assignments change
  const splitPartTotals = useMemo(() => {
    if (!editingSplit) return []
    return editingSplit.parts.map((_, i) =>
      splitEditorRows.reduce((s, r) => {
        const key = `${r._txId}/${r._subTxId}`
        return s + ((editingSplit.assignments[key] ?? 0) === i ? parseMoney(r['Outflow']) : 0)
      }, 0)
    )
  }, [editingSplit, splitEditorRows])

  const openSplitEditor = (catName) => {
    const existing = splits.get(catName)
    setEditingSplit({
      catName,
      parts: existing?.parts ?? [catName, ''],
      assignments: existing?.assignments ?? {},
      manualKeys: new Set(existing?.manualKeys ?? []),
    })
    setSelectedCategory(null)
  }

  // Called when user drags a transaction card to a column.
  // Marks the transaction as ground truth, then re-classifies all non-manual rows.
  const handleManualAssign = (txKey, partIdx) => {
    setEditingSplit(prev => {
      const manualKeys = new Set(prev.manualKeys)
      manualKeys.add(txKey)
      const assignments = { ...prev.assignments, [txKey]: partIdx }
      const reclassified = classifyAll(splitEditorRows, assignments, manualKeys, prev.parts.length)
      return { ...prev, assignments: reclassified ?? assignments, manualKeys }
    })
  }

  const saveSplit = () => {
    const validParts = editingSplit.parts.map(p => p.trim()).filter(Boolean)
    if (validParts.length < 2) return
    setSplits(prev => {
      const next = new Map(prev)
      next.set(editingSplit.catName, {
        parts: validParts,
        assignments: editingSplit.assignments,
        manualKeys: [...editingSplit.manualKeys],
      })
      return next
    })
    setEditingSplit(null)
  }

  const renderCell = ({ x, y, width, height, depth, name, value, groupColorIndex, _splitFrom }) => {
    if (depth === 0 || !width || !height || width < 2 || height < 2) return null
    const color = COLORS[groupColorIndex % COLORS.length]

    if (depth === 1) {
      return (
        <g style={{ pointerEvents: 'none' }}>
          <rect data-group-name={name} x={x} y={y} width={width} height={height} fill={color} stroke="#fff" strokeWidth={3} opacity={0.9} />
        </g>
      )
    }

    // depth === 2: category cell
    const isDraggingThis = dragging === name
    const isTarget       = dropTarget === name && dragging && dragging !== name
    const showText       = width > 50  && height > 24
    const showValue      = width > 70  && height > 44
    return (
      <g
        style={{ cursor: dragging ? (isDraggingThis ? 'grabbing' : 'copy') : 'pointer', userSelect: 'none' }}
        onMouseDown={e => { e.preventDefault(); setDragging(name) }}
        onMouseEnter={() => { if (dragging && dragging !== name) setDropTarget(name) }}
        onMouseLeave={() => { if (dropTarget === name) setDropTarget(null) }}
        onMouseUp={() => {
          if (dragging && dragging !== name) {
            handleMerge(dragging, name)
            setDragging(null)
            setDropTarget(null)
          } else if (dragging === name) {
            if (_splitFrom) {
              openSplitEditor(_splitFrom)
            } else {
              setSelectedCategory(prev => prev === name ? null : name)
              setEditingSplit(null)
            }
            setDragging(null)
          }
        }}
        onContextMenu={e => {
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY, name: _splitFrom ?? name })
          setEditingGroup(null)
        }}
      >
        <rect x={x} y={y} width={width} height={height} fill={color} stroke="#fff" strokeWidth={isTarget ? 3 : 1} opacity={isDraggingThis ? 0.35 : 0.85} />
        {isTarget && <rect x={x+2} y={y+2} width={width-4} height={height-4} fill="none" stroke="#fff" strokeWidth={2} strokeDasharray="5 3" />}
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

  const total        = twoLevelData.reduce((s, g) => s + g.children.reduce((s2, c) => s2 + c.value, 0), 0)
  const visibleCount = twoLevelData.reduce((s, g) => s + g.children.length, 0)

  return (
    <div>
      <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '16px', fontSize: '14px', color: '#555' }}>
        <span>Total spending: <strong style={{ color: '#2c3e50' }}>{dollarFormatter(total)}</strong>{' '}across <strong>{visibleCount}</strong> categories</span>
        {mergeOrder.length > 0 && (
          <button onClick={handleUndo} style={{ fontSize: '12px', padding: '2px 10px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4' }}>
            Undo merge (⌘Z)
          </button>
        )}
        {dragging && (
          <span style={{ color: '#888', fontStyle: 'italic' }}>Drop onto another category to merge</span>
        )}
      </div>

      <div style={{ position: 'relative' }} ref={svgWrapperRef}>
        <ResponsiveContainer width="99%" height={420}>
          <Treemap data={twoLevelData} dataKey="value" content={renderCell} isAnimationActive={false}>
            <Tooltip content={<CustomTooltip />} animationDuration={0} wrapperStyle={{ zIndex: 10 }} />
          </Treemap>
        </ResponsiveContainer>
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
          {twoLevelData.map(({ name, groupColorIndex }) => {
            const pos = groupPositions[name]
            if (!pos) return null
            const color = COLORS[groupColorIndex % COLORS.length]
            const isEditing = editingGroup?.name === name
            return (
              <div
                key={name}
                onClick={() => { if (!isEditing) setEditingGroup({ name, value: name }) }}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: pos.width,
                  height: 20,
                  background: color,
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft: 6,
                  boxSizing: 'border-box',
                  pointerEvents: 'auto',
                  cursor: 'text',
                  borderBottom: '1px solid rgba(255,255,255,0.35)',
                }}
              >
                {isEditing ? (
                  <input
                    autoFocus
                    value={editingGroup.value}
                    onChange={e => setEditingGroup(prev => ({ ...prev, value: e.target.value }))}
                    onBlur={() => { onRenameGroup(editingGroup.name, editingGroup.value); setEditingGroup(null) }}
                    onKeyDown={e => {
                      if (e.key === 'Enter')  { e.stopPropagation(); onRenameGroup(editingGroup.name, editingGroup.value); setEditingGroup(null) }
                      if (e.key === 'Escape') { e.stopPropagation(); setEditingGroup(null) }
                    }}
                    style={{ background: 'transparent', border: 'none', outline: '1px solid rgba(255,255,255,0.8)', color: '#fff', fontSize: '11px', fontWeight: 700, fontFamily: 'sans-serif', width: '100%', padding: '0 4px', boxSizing: 'border-box' }}
                  />
                ) : (
                  <span style={{ color: '#fff', fontSize: '11px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none' }}>
                    {name}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {contextMenu && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 1000,
            overflow: 'hidden',
            fontSize: '13px',
            minWidth: '140px',
          }}
        >
          <div
            onClick={() => { openSplitEditor(contextMenu.name); setContextMenu(null) }}
            style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: splits.has(contextMenu.name) ? '1px solid #eee' : 'none' }}
          >
            Split...
          </div>
          {splits.has(contextMenu.name) && (
            <div
              onClick={() => {
                setSplits(prev => { const next = new Map(prev); next.delete(contextMenu.name); return next })
                setContextMenu(null)
              }}
              style={{ padding: '8px 16px', cursor: 'pointer', color: '#c0392b' }}
            >
              Remove split
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', marginTop: '24px' }}>
        <table style={{ fontSize: '13px', borderCollapse: 'collapse', flexShrink: 0, width: '340px' }}>
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

        {editingSplit ? (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '520px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexShrink: 0 }}>
              <span style={{ fontWeight: 600, fontSize: '14px', color: '#2c3e50' }}>
                Split: <em style={{ fontWeight: 400 }}>{editingSplit.catName}</em>
              </span>
              <button
                onClick={() => setEditingSplit(prev => ({ ...prev, parts: [...prev.parts, ''] }))}
                style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}
              >+ Add part</button>
              <button
                onClick={saveSplit}
                style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #27ae60', borderRadius: '3px', background: '#27ae60', color: '#fff' }}
              >Save</button>
              <button
                onClick={() => setEditingSplit(null)}
                style={{ marginLeft: 'auto', fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}
              >Cancel</button>
            </div>
            <div style={{ display: 'flex', gap: '10px', flex: 1, minHeight: 0 }}>
              {editingSplit.parts.map((part, partIdx) => {
                const partRows = splitEditorRows.filter(r =>
                  (editingSplit.assignments[`${r._txId}/${r._subTxId}`] ?? 0) === partIdx
                )
                return (
                  <div
                    key={partIdx}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault()
                      const key = e.dataTransfer.getData('text/plain')
                      if (key) handleManualAssign(key, partIdx)
                    }}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}
                  >
                    <div style={{ marginBottom: '6px', flexShrink: 0 }}>
                      <input
                        value={part}
                        onChange={e => setEditingSplit(prev => {
                          const parts = [...prev.parts]
                          parts[partIdx] = e.target.value
                          return { ...prev, parts }
                        })}
                        placeholder="Sub-category name"
                        style={{ width: '100%', fontSize: '13px', fontWeight: 600, padding: '4px 6px', border: '1px solid #ccc', borderRadius: '3px', boxSizing: 'border-box' }}
                      />
                      <div style={{ fontSize: '12px', color: '#27ae60', fontWeight: 600, marginTop: '2px', paddingLeft: '2px' }}>
                        {dollarFormatter(splitPartTotals[partIdx] ?? 0)}
                        <span style={{ fontWeight: 400, color: '#999', marginLeft: '6px' }}>{partRows.length} transactions</span>
                      </div>
                    </div>
                    <div style={{
                      flex: 1,
                      overflow: 'auto',
                      background: '#f0f2f5',
                      borderRadius: '6px',
                      padding: '6px',
                      border: '2px dashed transparent',
                    }}>
                      {partRows.map(row => {
                        const key = `${row._txId}/${row._subTxId}`
                        const isManual = editingSplit.manualKeys.has(key)
                        return (
                          <div
                            key={key}
                            draggable
                            onDragStart={e => e.dataTransfer.setData('text/plain', key)}
                            style={{
                              padding: '6px 8px',
                              marginBottom: '4px',
                              background: isManual ? '#e8f5e9' : '#fff',
                              border: `1px solid ${isManual ? '#81c784' : '#ddd'}`,
                              borderRadius: '4px',
                              cursor: 'grab',
                              fontSize: '12px',
                              userSelect: 'none',
                            }}
                          >
                            <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {row['Payee']}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', color: '#888' }}>
                              <span>{row['Date']}</span>
                              <span style={{ fontWeight: 500, color: '#555' }}>{row['Outflow']}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : selectedCategory ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '8px', color: '#2c3e50', display: 'flex', alignItems: 'baseline', gap: '12px' }}>
              {selectedCategory}
              <span style={{ fontWeight: 400, fontSize: '13px', color: '#555' }}>{dollarFormatter(filteredRows.reduce((s, r) => s + parseMoney(r['Outflow']), 0))}</span>
              <button onClick={() => toggleHidden(selectedCategory)} style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}>
                {hiddenNames.has(selectedCategory) ? 'show' : 'hide'}
              </button>
              <button onClick={() => setSelectedCategory(null)} style={{ marginLeft: 'auto', fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}>✕</button>
            </div>
            <div style={{ height: '500px', border: '1px solid #ddd', borderRadius: '4px', overflow: 'hidden' }}>
              <TransactionsTab
                rows={filteredRows}
                categoryGroups={categoryGroups}
                onUpdateCategory={onUpdateCategory}
                onBulkUpdateCategory={onBulkUpdateCategory}
                onUpdateMemo={onUpdateMemo}
                isMainScenario={isMainScenario}
                hiddenCols={['Account', 'Inflow']}
              />
            </div>
          </div>
        ) : null}
      </div>

    </div>
  )
}
