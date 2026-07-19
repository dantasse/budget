import { useMemo, useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { Treemap, ResponsiveContainer, Tooltip } from 'recharts'
import TransactionsTab from './TransactionsTab'

function parseMoney(val) {
  if (!val) return 0
  return parseFloat(val.replace(/[$,]/g, '')) || 0
}

function netSpend(row) {
  return parseMoney(row['Outflow']) - parseMoney(row['Inflow'])
}

const COLORS = [
  '#2c3e50', '#2980b9', '#27ae60', '#8e44ad', '#e67e22',
  '#c0392b', '#16a085', '#d35400', '#7f8c8d', '#f39c12',
  '#1abc9c', '#e74c3c', '#3498db', '#9b59b6', '#2ecc71',
]

const OVERLAY_BTN_STYLE = { fontSize: '10px', padding: '0 6px', cursor: 'pointer', border: '1px solid rgba(255,255,255,0.6)', borderRadius: '3px', background: 'rgba(0,0,0,0.35)', color: '#fff', flexShrink: 0 }

const SMALL_BTN_STYLE = { fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }

const ZOOM_MS = 300

const dollarFormatter = (value) =>
  '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

// SVG doesn't clip text to its parent rect, so cell labels are truncated to fit.
// Canvas measureText with the page font (sans-serif) gives real pixel widths.
const measureCtx = document.createElement('canvas').getContext('2d')
function truncateToWidth(text, maxWidth, font) {
  measureCtx.font = font
  if (measureCtx.measureText(text).width <= maxWidth) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureCtx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}

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

const round2 = (v) => Math.round(v * 100) / 100

export default function ReportsTab({ rows, budgetId, scenario, catTree, catOptions, mergeChildren, onUpdateCategory, onBulkUpdateCategory, onUpdateMemo, isMainScenario, onRenameNode, onMoveNode, onMergeNode, onUnmergeNode, onSplitNode, onAbsorbChildren, onPushUndo, onRemoveUndos }) {
  // all view state is node-id-keyed; the old name-keyed keys are abandoned
  const hiddenKey = `ynab_report_hiddennodes_${budgetId}_${scenario}`
  const lumpsKey  = `ynab_report_lumpnodes_${budgetId}_${scenario}`

  // hiddenIds: Set<nodeId> — node + subtree excluded from the treemap
  const [hiddenIds, setHiddenIds] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(hiddenKey)) ?? []) }
    catch { return new Set() }
  })
  // lumpedIds: Set<nodeId> — that box renders as one cell (subtree total) instead of per-child cells
  const [lumpedIds, setLumpedIds] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(lumpsKey)) ?? []) }
    catch { return new Set() }
  })
  // dragging: { id, name, boxId } of the dragged cell's node | null
  const [dragging,       setDragging]       = useState(null)
  // dropTarget: `cell:${id}` (merge) | `box:${id}` (move into) | null
  const [dropTarget,     setDropTarget]     = useState(null)
  const [selectedId,     setSelectedId]     = useState(null)
  // selectedPayee: narrows the detail panel to one payee within selectedId (set from payee boxes)
  const [selectedPayee,  setSelectedPayee]  = useState(null)
  const [editingNode,    setEditingNode]    = useState(null) // { id, value } | null
  const [contextMenu,    setContextMenu]    = useState(null) // { x, y, id, name } | null
  // editingSplit: { sourceId, sourceName, parts, assignments, manualKeys, automatic } | null
  const [editingSplit,   setEditingSplit]   = useState(null)
  const [splitSelectedKeys, setSplitSelectedKeys] = useState(new Set())
  // splitFocusedKey: key of card with keyboard focus, for shift+up/down range-select
  const [splitFocusedKey,   setSplitFocusedKey]   = useState(null)
  const [groupPositions, setGroupPositions] = useState({}) // box node id → { x, y, width, height }
  const [tableSort,      setTableSort]      = useState({ key: 'value', dir: 'desc' })
  // zoomId: node whose children fill the treemap; null = top level
  const [zoomId,         setZoomId]         = useState(null)
  // payeeSplitIds: leaf/lumped boxes shown broken down by payee (view-only, not persisted)
  const [payeeSplitIds,  setPayeeSplitIds]  = useState(new Set())
  // zoomAnim: { transform, transition } while the zoom in/out animation plays, else null
  const [zoomAnim,       setZoomAnim]       = useState(null)
  // stack of { id, transform } for animating nested zoom-outs one level at a time
  const zoomStackRef = useRef([])
  const [dragLabel,      setDragLabel]      = useState(null) // { text, x, y, width, height } | null
  const [catSearch,      setCatSearch]      = useState('')
  const svgWrapperRef = useRef(null)
  // most-recent selection from the embedded detail-panel TransactionsTab; used to preload split parts
  const detailSelectionRef = useRef(new Set())

  const tree = catTree.byId

  useEffect(() => {
    localStorage.setItem(hiddenKey, JSON.stringify([...hiddenIds]))
  }, [hiddenIds, hiddenKey])

  useEffect(() => {
    localStorage.setItem(lumpsKey, JSON.stringify([...lumpedIds]))
  }, [lumpedIds, lumpsKey])

  // ops can remove the selected/zoomed/split node from the tree; drop dead references
  useEffect(() => {
    if (selectedId && !tree.has(selectedId)) { setSelectedId(null); setSelectedPayee(null) }
    if (zoomId && !tree.has(zoomId)) { setZoomId(null); zoomStackRef.current = [] }
    if (editingSplit && !tree.has(editingSplit.sourceId)) setEditingSplit(null)
  }, [catTree])

  // noData renders an early-return placeholder with no treemap wrapper, so the
  // observer must (re-)attach when data appears — with [] deps, mounting during
  // the initial fetch left it permanently unattached and the group labels never rendered
  const noData = rows.length === 0
  useEffect(() => {
    const el = svgWrapperRef.current
    if (!el) return
    const read = () => {
      const next = {}
      el.querySelectorAll('[data-group-id]').forEach(rect => {
        const x = parseFloat(rect.getAttribute('x'))
        const y = parseFloat(rect.getAttribute('y'))
        const width = parseFloat(rect.getAttribute('width'))
        const height = parseFloat(rect.getAttribute('height'))
        if (width > 2 && height > 2) next[rect.getAttribute('data-group-id')] = { x, y, width, height }
      })
      setGroupPositions(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
    }
    const mo = new MutationObserver(read)
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['x', 'y', 'width', 'height', 'data-group-id'] })
    read()
    return () => mo.disconnect()
  }, [noData])

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

  const splitStateRef = useRef({})

  // ancestor names, root → node (exclusive of the node itself)
  const ancestorNames = useCallback((id) => {
    const names = []
    let cur = tree.get(id)
    cur = cur && cur.parentId !== null ? tree.get(cur.parentId) : undefined
    while (cur) {
      names.unshift(cur.name)
      cur = cur.parentId !== null ? tree.get(cur.parentId) : undefined
    }
    return names
  }, [tree])

  // true when id sits in ancestorId's subtree (inclusive)
  const inSub = useCallback((ancestorId, id) => {
    let cur = tree.get(id)
    while (cur) {
      if (cur.id === ancestorId) return true
      cur = cur.parentId !== null ? tree.get(cur.parentId) : undefined
    }
    return false
  }, [tree])

  // like inSub, but false when a hidden node sits on the path (ancestor exclusive)
  const visiblyInSub = useCallback((ancestorId, id) => {
    let cur = tree.get(id)
    while (cur) {
      if (cur.id === ancestorId) return true
      if (hiddenIds.has(cur.id)) return false
      cur = cur.parentId !== null ? tree.get(cur.parentId) : undefined
    }
    return false
  }, [tree, hiddenIds])

  const toggleLump = useCallback((id) => {
    const wasLumped = lumpedIds.has(id)
    onPushUndo({ label: wasLumped ? 'unlump' : 'lump', scope: 'reports', undo: () => setLumpedIds(prev => {
      const next = new Set(prev)
      wasLumped ? next.add(id) : next.delete(id)
      return next
    })})
    setLumpedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [lumpedIds, onPushUndo])

  const togglePayeeSplit = useCallback((id) => {
    const wasSplit = payeeSplitIds.has(id)
    onPushUndo({ label: wasSplit ? 'payees off' : 'payees', scope: 'reports', undo: () => setPayeeSplitIds(prev => {
      const next = new Set(prev)
      wasSplit ? next.add(id) : next.delete(id)
      return next
    })})
    setPayeeSplitIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [payeeSplitIds, onPushUndo])

  const startZoom = (id) => {
    const el  = svgWrapperRef.current
    const pos = groupPositions[id]
    let transform = null
    if (el && pos) {
      const { width: W, height: H } = el.getBoundingClientRect()
      transform = `translate(${pos.x}px, ${pos.y}px) scale(${pos.width / W}, ${pos.height / H})`
    }
    zoomStackRef.current = [...zoomStackRef.current, { id, transform }]
    setZoomId(id)
    if (!transform) return // nothing to animate from; jump cut
    setZoomAnim({ transform, transition: false })
    // two frames: first paints the shrunk state, second starts the transition
    requestAnimationFrame(() => requestAnimationFrame(() =>
      setZoomAnim({ transform: 'none', transition: true })))
    setTimeout(() => setZoomAnim(null), ZOOM_MS + 100)
  }

  // zoom out to an ancestor (null = top). One level animates; bigger jumps cut.
  const zoomTo = (targetId) => {
    const stack = zoomStackRef.current
    const keep  = targetId === null ? 0 : stack.findIndex(e => e.id === targetId) + 1
    const popped = stack.slice(keep)
    zoomStackRef.current = stack.slice(0, keep)
    const t = popped.length === 1 ? popped[0].transform : null
    if (!t) { setZoomId(targetId); setZoomAnim(null); return }
    setZoomAnim({ transform: t, transition: true })
    setTimeout(() => {
      setZoomId(targetId)
      setZoomAnim(null)
    }, ZOOM_MS)
  }

  // this component's undo closures die with it, so drop them from the app stack on unmount
  useEffect(() => {
    return () => onRemoveUndos(e => e.scope === 'reports' || e.scope === 'splitEditor')
  }, [onRemoveUndos])

  // directTotals: node id → net spend of rows resolved directly to it
  // (unfiltered by hiding — the table greys hidden rows but still shows them)
  const directTotals = useMemo(() => {
    const m = new Map()
    for (const row of rows) {
      const id = row._categoryId
      if (!id || !tree.has(id)) continue
      const net = netSpend(row)
      if (net === 0) continue
      m.set(id, (m.get(id) ?? 0) + net)
    }
    return m
  }, [rows, tree])

  // subtree total, skipping hidden descendants (what a treemap cell displays)
  const subtreeTotal = useMemo(() => {
    const cache = new Map()
    const calc = (id) => {
      if (cache.has(id)) return cache.get(id)
      let v = directTotals.get(id) ?? 0
      for (const c of tree.get(id).childIds) if (!hiddenIds.has(c)) v += calc(c)
      cache.set(id, v)
      return v
    }
    return calc
  }, [tree, directTotals, hiddenIds])

  // treemap data: children of the zoom root as boxes; inside each box one cell
  // per child subtree (+ a cell for the box's own direct transactions), or a
  // single self cell when the box is lumped or childless, or payee cells when
  // payee split is on. Cells with value ≤ 0 are dropped and listed below.
  const { data: treemapData, excluded } = useMemo(() => {
    const rootChildIds = zoomId ? (tree.get(zoomId)?.childIds ?? []) : catTree.rootIds
    const excluded = []
    const data = rootChildIds
      .filter(id => !hiddenIds.has(id))
      .map((id, gi) => {
        const n = tree.get(id)
        const visibleChildIds = n.childIds.filter(c => !hiddenIds.has(c))
        const asSelf = lumpedIds.has(id) || visibleChildIds.length === 0
        let cells
        if (asSelf && payeeSplitIds.has(id)) {
          const byPayee = new Map()
          for (const row of rows) {
            if (!row._categoryId || !visiblyInSub(id, row._categoryId)) continue
            const net = netSpend(row)
            if (net === 0) continue
            const p = row['Payee'] || '(none)'
            byPayee.set(p, (byPayee.get(p) ?? 0) + net)
          }
          cells = [...byPayee.entries()].map(([p, v]) => ({ name: p, value: round2(v), _id: id, _payee: p }))
        } else if (asSelf) {
          cells = [{ name: n.name, value: round2(subtreeTotal(id)), _id: id, _self: true }]
        } else {
          cells = visibleChildIds.map(c => ({ name: tree.get(c).name, value: round2(subtreeTotal(c)), _id: c }))
          const direct = directTotals.get(id) ?? 0
          if (direct !== 0) cells.push({ name: n.name, value: round2(direct), _id: id, _direct: true })
        }
        cells = cells.map(c => ({ ...c, groupColorIndex: gi, _boxId: id, _boxName: n.name }))
        for (const c of cells) {
          // zero-value cells (empty nodes) just don't render; the strip lists real
          // negatives, plus a zero lumped box so its un-lump button stays reachable
          if (c.value < 0 || (c.value === 0 && c._self && lumpedIds.has(id))) {
            excluded.push({ name: c.name, boxName: n.name, boxId: id, value: c.value, isLumpSelf: !!c._self && lumpedIds.has(id) })
          }
        }
        return {
          name: n.name,
          _id: id,
          groupColorIndex: gi,
          children: cells.filter(c => c.value > 0).sort((a, b) => b.value - a.value),
        }
      })
      .filter(g => g.children.length > 0)
      .sort((a, b) => {
        const aSum = a.children.reduce((s, c) => s + c.value, 0)
        const bSum = b.children.reduce((s, c) => s + c.value, 0)
        return bSum - aSum
      })
    excluded.sort((a, b) => a.value - b.value)
    return { data, excluded }
  }, [zoomId, tree, catTree, hiddenIds, lumpedIds, payeeSplitIds, rows, directTotals, subtreeTotal, visiblyInSub])

  // table: one row per node holding transactions directly
  const allData = useMemo(() => {
    return [...directTotals.entries()]
      .map(([id, value]) => ({
        id,
        name: tree.get(id).name,
        group: ancestorNames(id).join(' / '),
        value: round2(value),
      }))
      .sort((a, b) => b.value - a.value)
      // colorIndex is fixed by the default (spending-desc) order so swatches don't change when re-sorting
      .map((d, i) => ({ ...d, colorIndex: i }))
  }, [directTotals, tree, ancestorNames])

  const sortedAllData = useMemo(() => {
    const field = tableSort.key === 'share' ? 'value' : tableSort.key
    const mul = tableSort.dir === 'desc' ? -1 : 1
    return [...allData].sort((a, b) => {
      const av = a[field]
      const bv = b[field]
      const cmp = typeof av === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''))
      return mul * cmp
    })
  }, [allData, tableSort])

  // childTotals: node id → net spend of rows that originally belonged to that
  // (merged-away) category; _ynabCategoryId preserves the pre-resolution id
  const childTotals = useMemo(() => {
    const totals = new Map()
    for (const row of rows) {
      const orig = row._ynabCategoryId
      if (!orig || orig === row._categoryId) continue
      const net = netSpend(row)
      if (net === 0) continue
      totals.set(orig, (totals.get(orig) ?? 0) + net)
    }
    return totals
  }, [rows])

  const filteredRows = useMemo(() => {
    if (!selectedId) return []
    const base = rows.filter(r => r._categoryId && inSub(selectedId, r._categoryId))
    if (!selectedPayee) return base
    return base.filter(r => (r['Payee'] || '(none)') === selectedPayee)
  }, [selectedId, selectedPayee, rows, inSub])

  const splitEditorRows = useMemo(() => {
    if (!editingSplit) return []
    return rows.filter(r => r._categoryId === editingSplit.sourceId)
      .sort((a, b) => (b['Date'] ?? '').localeCompare(a['Date'] ?? ''))
  }, [editingSplit?.sourceId, rows])

  // per-part spending totals, recomputed as assignments change
  const splitPartTotals = useMemo(() => {
    if (!editingSplit) return []
    return editingSplit.parts.map((_, i) =>
      splitEditorRows.reduce((s, r) => {
        const key = `${r._txId}/${r._subTxId}`
        return s + ((editingSplit.assignments[key] ?? 0) === i ? netSpend(r) : 0)
      }, 0)
    )
  }, [editingSplit, splitEditorRows])

  // Shift+Up/Down extends card selection within the focused card's column.
  // Placed after splitEditorRows so the ref update is valid.
  splitStateRef.current = { editingSplit, splitFocusedKey, splitSelectedKeys, splitEditorRows }
  useEffect(() => {
    const handler = (e) => {
      if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      const { editingSplit, splitFocusedKey, splitEditorRows } = splitStateRef.current
      if (!editingSplit || !splitFocusedKey) return
      e.preventDefault()
      const focusedPart = editingSplit.assignments[splitFocusedKey] ?? 0
      const partKeys = splitEditorRows
        .filter(r => (editingSplit.assignments[`${r._txId}/${r._subTxId}`] ?? 0) === focusedPart)
        .map(r => `${r._txId}/${r._subTxId}`)
      const idx = partKeys.indexOf(splitFocusedKey)
      if (idx === -1) return
      const nextIdx = e.key === 'ArrowDown' ? Math.min(idx + 1, partKeys.length - 1) : Math.max(idx - 1, 0)
      if (nextIdx === idx) return
      setSplitSelectedKeys(prev => new Set([...prev, partKeys[nextIdx]]))
      setSplitFocusedKey(partKeys[nextIdx])
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const openSplitEditor = (sourceId, preassignedKeys) => {
    const sourceName = tree.get(sourceId)?.name
    if (!sourceName) return
    let assignments  = {}
    const manualKeys = new Set()
    // both parts become child categories of the source; part 0 (the remainder
    // that unassigned/future transactions follow) starts as "Other"
    const parts      = ['Other', '']
    if (preassignedKeys && preassignedKeys.size > 0) {
      for (const k of preassignedKeys) {
        assignments[k] = 1
        manualKeys.add(k)
      }
      const editorRows = rows.filter(r => r._categoryId === sourceId)
      const reclassified = classifyAll(editorRows, assignments, manualKeys, parts.length)
      if (reclassified) assignments = reclassified
    }
    setEditingSplit({ sourceId, sourceName, parts, assignments, manualKeys, automatic: true })
    onRemoveUndos(e => e.scope === 'splitEditor')
    setSplitSelectedKeys(new Set())
    setSplitFocusedKey(null)
    setSelectedId(null)
    setSelectedPayee(null)
  }

  // closing the editor invalidates its undo entries (they reference the open editor's state)
  const closeSplitEditor = () => {
    setEditingSplit(null)
    onRemoveUndos(e => e.scope === 'splitEditor')
  }

  const assignToSplitPart = (txKeys, partIdx) => {
    const prevAssignments = editingSplit.assignments
    const prevManualKeys  = new Set(editingSplit.manualKeys)
    onPushUndo({ scope: 'splitEditor', undo: () =>
      setEditingSplit(prev => ({ ...prev, assignments: prevAssignments, manualKeys: prevManualKeys }))
    })
    setEditingSplit(prev => {
      const manualKeys = new Set(prev.manualKeys)
      txKeys.forEach(k => manualKeys.add(k))
      let assignments = { ...prev.assignments }
      txKeys.forEach(k => { assignments[k] = partIdx })
      if (prev.automatic) {
        const reclassified = classifyAll(splitEditorRows, assignments, manualKeys, prev.parts.length)
        if (reclassified) assignments = reclassified
      }
      return { ...prev, assignments, manualKeys }
    })
    setSplitSelectedKeys(new Set())
    setSplitFocusedKey(null)
  }

  const saveSplit = () => {
    const { sourceId, parts, assignments } = editingSplit
    const validParts = parts.map(p => p.trim()).filter(Boolean)
    if (validParts.length < 2) return
    onSplitNode(sourceId, validParts, assignments)
    closeSplitEditor()
  }

  const toggleHidden = (id) =>
    setHiddenIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const selectCell = (id, payee) => {
    const same = selectedId === id && selectedPayee === payee
    setSelectedId(same ? null : id)
    setSelectedPayee(same ? null : payee)
    closeSplitEditor()
  }

  const renderCell = (props) => {
    const { x, y, width, height, depth, name, value, groupColorIndex, _id, _boxId, _boxName, _payee, _self } = props
    if (depth === 0 || !width || !height || width < 2 || height < 2) return null
    const color = COLORS[groupColorIndex % COLORS.length]

    if (depth === 1) {
      return (
        <g style={{ pointerEvents: 'none' }}>
          <rect data-group-id={_id} x={x} y={y} width={width} height={height} fill={color} stroke="#fff" strokeWidth={3} opacity={0.9} />
        </g>
      )
    }

    // depth === 2: one cell = one node subtree (or the box's own direct/self/payee slice)
    const isNodeCell     = !_payee
    const draggable      = isNodeCell && _id !== _boxId
    const isDraggingThis = dragging?.id === _id && draggable
    // dragging within the box the dragged node already lives in — a move there would be a no-op
    const sameBox        = dragging && dragging.id !== _id && dragging.boxId === _boxId
    const isMergeTarget  = dropTarget === `cell:${_id}` && dragging && dragging.id !== _id && isNodeCell
    const isMoveTarget   = dropTarget === `box:${_boxId}` && dragging && dragging.boxId !== _boxId
    const showText       = width > 50  && height > 24 && !_self
    const showValue      = width > 70  && height > 44
    const textY          = y + height/2 + (showValue ? -7 : 4)
    const valueY         = y + height/2 + (showText ? 10 : 4)

    const handleMouseUp = () => {
      if (dragging && dragging.id !== _id && isNodeCell) {
        // ops push their own undo snapshots in App
        if (isMergeTarget || sameBox) onMergeNode(dragging.id, _id)
        else onMoveNode(dragging.id, _boxId)
        setDragging(null)
        setDropTarget(null)
        setDragLabel(null)
      } else if (dragging && dragging.id === _id) {
        selectCell(_id, null)
        setDragging(null)
      } else if (!dragging && !draggable) {
        selectCell(_id, _payee ?? null)
      }
    }

    return (
      <g
        style={{ cursor: dragging ? (isDraggingThis ? 'grabbing' : 'copy') : 'pointer', userSelect: 'none' }}
        onMouseDown={e => {
          e.preventDefault()
          if (draggable) setDragging({ id: _id, name, boxId: _boxId })
        }}
        onMouseLeave={() => {
          if (dropTarget === `cell:${_id}` || dropTarget === `box:${_boxId}`) setDropTarget(null)
          setDragLabel(null)
        }}
        onMouseUp={handleMouseUp}
        onContextMenu={isNodeCell ? e => {
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY, id: _id, name })
          setEditingNode(null)
        } : undefined}
      >
        {/* background rect: drop here = move into this box's node */}
        <rect
          x={x} y={y} width={width} height={height}
          fill={color} stroke="#fff"
          strokeWidth={isMergeTarget || isMoveTarget ? 3 : 1}
          opacity={isDraggingThis ? 0.35 : 0.85}
          onMouseEnter={() => {
            if (dragging && dragging.id !== _id) {
              if (sameBox && isNodeCell) {
                setDropTarget(`cell:${_id}`)
                setDragLabel({ text: `Merge with ${name}`, x, y, width, height })
              } else if (!sameBox && dragging.boxId !== _boxId) {
                setDropTarget(`box:${_boxId}`)
                const gPos = groupPositions[_boxId] ?? { x, y, width, height }
                setDragLabel({ text: `Move ${dragging.name} to ${_boxName}`, ...gPos })
              }
            }
          }}
        />
        {isMergeTarget && (
          <rect x={x+2} y={y+2} width={width-4} height={height-4} fill="none" stroke="#fff" strokeWidth={2} strokeDasharray="5 3" />
        )}
        {catSearch && !name.toLowerCase().includes(catSearch.toLowerCase()) && (
          <rect x={x} y={y} width={width} height={height} fill="#fff" opacity={0.60} style={{ pointerEvents: 'none' }} />
        )}
        {showText && !isDraggingThis && (
          <>
            <text x={x + width/2} y={textY} textAnchor="middle" fill="#fff" fontSize={12} fontWeight={600} style={{ pointerEvents: 'none' }}>
              {truncateToWidth(name, width - 8, '600 12px sans-serif')}
            </text>
            {/* invisible hit-zone over text label: drop here = merge (only when cross-box) */}
            {isNodeCell && (
              <rect
                x={x + width * 0.1} y={textY - 11} width={width * 0.8} height={16}
                fill="transparent"
                style={{ pointerEvents: dragging && dragging.id !== _id && !sameBox ? 'auto' : 'none' }}
                onMouseEnter={() => {
                  if (dragging && dragging.id !== _id) {
                    setDropTarget(`cell:${_id}`)
                    setDragLabel({ text: `Merge with ${name}`, x, y, width, height })
                  }
                }}
                onMouseLeave={() => {
                  if (dropTarget === `cell:${_id}` && dragging && !sameBox) {
                    setDropTarget(`box:${_boxId}`)
                    const gPos = groupPositions[_boxId] ?? { x, y, width, height }
                    setDragLabel({ text: `Move ${dragging.name} to ${_boxName}`, ...gPos })
                  }
                }}
              />
            )}
          </>
        )}
        {(showValue || (_self && width > 50 && height > 24)) && !isDraggingThis && (
          <text x={x + width/2} y={valueY} textAnchor="middle" fill="#fff" fontSize={11} opacity={0.85} style={{ pointerEvents: 'none' }}>
            {dollarFormatter(value)}
          </text>
        )}
      </g>
    )
  }

  if (rows.length === 0) return (
    <div style={{ color: '#555', padding: '24px 0' }}>No data loaded.</div>
  )

  // the header total is scoped to the current zoom; the table's Share column
  // stays global (top-level, hidden roots excluded) so it doesn't shift when zooming
  const total        = treemapData.reduce((s, g) => s + g.children.reduce((s2, c) => s2 + c.value, 0), 0)
  const visibleCount = treemapData.reduce((s, g) => s + g.children.length, 0)
  const grandTotal   = catTree.rootIds
    .filter(id => !hiddenIds.has(id))
    .reduce((s, id) => s + Math.max(0, subtreeTotal(id)), 0)

  // breadcrumb: ancestors of the zoom root (top → zoomed node)
  const zoomTrail = []
  if (zoomId) {
    let cur = tree.get(zoomId)
    while (cur) {
      zoomTrail.unshift({ id: cur.id, name: cur.name })
      cur = cur.parentId !== null ? tree.get(cur.parentId) : undefined
    }
  }

  return (
    <div>
      <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '16px', fontSize: '14px', color: '#555' }}>
        <span>Total spending: <strong style={{ color: '#2c3e50' }}>{dollarFormatter(total)}</strong>{' '}across <strong>{visibleCount}</strong> categories</span>
        {zoomId && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: '#2c3e50' }}>
            <button onClick={() => zoomTo(null)} style={{ ...SMALL_BTN_STYLE, fontWeight: 400 }}>All</button>
            {zoomTrail.map(({ id, name }, i) => (
              <Fragment key={id}>
                <span style={{ color: '#aaa' }}>▸</span>
                {i < zoomTrail.length - 1
                  ? <button onClick={() => zoomTo(id)} style={{ ...SMALL_BTN_STYLE, fontWeight: 400 }}>{name}</button>
                  : <span>{name}</span>}
              </Fragment>
            ))}
            <button onClick={() => zoomTo(zoomTrail.length > 1 ? zoomTrail[zoomTrail.length - 2].id : null)} style={SMALL_BTN_STYLE}>✕</button>
          </span>
        )}
        {dragging && (
          <span style={{ color: '#888', fontStyle: 'italic' }}>Drop to move into that box; drop on the text label to merge</span>
        )}
      </div>

      <div style={{ marginBottom: '8px' }}>
        <input
          type="search"
          value={catSearch}
          onChange={e => setCatSearch(e.target.value)}
          placeholder="Search categories…"
          style={{ fontSize: '13px', padding: '4px 8px', border: '1px solid #ccc', borderRadius: '4px', width: '220px' }}
        />
      </div>

      <div style={{ position: 'relative' }} ref={svgWrapperRef}>
        {/* transform layer: scales treemap + labels together during zoom in/out */}
        <div style={{ position: 'relative', transformOrigin: '0 0', transform: zoomAnim?.transform ?? 'none', transition: zoomAnim?.transition ? `transform ${ZOOM_MS}ms ease` : 'none' }}>
        <ResponsiveContainer width="99%" height={420}>
          <Treemap data={treemapData} dataKey="value" content={renderCell} isAnimationActive={false}>
            <Tooltip content={<CustomTooltip />} animationDuration={0} wrapperStyle={{ zIndex: 10 }} />
          </Treemap>
        </ResponsiveContainer>
        {dragLabel && dragging && (
          <div style={{
            position: 'absolute',
            left: dragLabel.x, top: dragLabel.y,
            width: dragLabel.width, height: dragLabel.height,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', zIndex: 5,
          }}>
            <div style={{
              background: 'rgba(0,0,0,0.72)', color: '#fff',
              fontSize: '12px', fontWeight: 600,
              padding: '4px 10px', borderRadius: '20px', whiteSpace: 'nowrap',
            }}>
              {dragLabel.text}
            </div>
          </div>
        )}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
          {treemapData.map(({ name, _id }) => {
            const pos = groupPositions[_id]
            if (!pos) return null
            const isEditing = editingNode?.id === _id
            const node = tree.get(_id)
            const hasVisibleChildren = node && node.childIds.some(c => !hiddenIds.has(c))
            const commitRename = (value) => {
              onRenameNode(_id, value)
              setEditingNode(null)
            }
            return (
              <div
                key={_id}
                data-label-for={name}
                onClick={() => { if (!isEditing) setEditingNode({ id: _id, value: name }) }}
                style={{
                  position: 'absolute',
                  left: pos.x + 6,
                  top: pos.y + 4,
                  maxWidth: pos.width - 12,
                  maxHeight: pos.height - 8,
                  overflow: 'hidden',
                  pointerEvents: 'auto',
                  cursor: 'text',
                }}
              >
                {isEditing ? (
                  <input
                    autoFocus
                    value={editingNode.value}
                    onChange={e => setEditingNode(prev => ({ ...prev, value: e.target.value }))}
                    onBlur={() => commitRename(editingNode.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter')  { e.stopPropagation(); commitRename(editingNode.value) }
                      if (e.key === 'Escape') { e.stopPropagation(); setEditingNode(null) }
                    }}
                    style={{ background: 'rgba(0,0,0,0.35)', border: 'none', outline: 'none', color: '#fff', fontSize: '12px', fontWeight: 700, fontFamily: 'sans-serif', width: '160px', padding: '0 2px', borderBottom: '1px solid rgba(255,255,255,0.7)' }}
                  />
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: '#fff', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, userSelect: 'none', textShadow: '0 1px 3px rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.3)' }}>
                      {name}
                    </span>
                    {hasVisibleChildren ? (
                      <>
                        <button
                          onClick={e => { e.stopPropagation(); toggleLump(_id) }}
                          onMouseDown={e => e.stopPropagation()}
                          style={OVERLAY_BTN_STYLE}
                        >
                          {lumpedIds.has(_id) ? 'unlump' : 'lump'}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); startZoom(_id) }}
                          onMouseDown={e => e.stopPropagation()}
                          style={OVERLAY_BTN_STYLE}
                        >
                          zoom
                        </button>
                      </>
                    ) : (
                      <>
                        {/* split = the real op: carve out child subcategories */}
                        <button
                          onClick={e => { e.stopPropagation(); openSplitEditor(_id) }}
                          onMouseDown={e => e.stopPropagation()}
                          style={OVERLAY_BTN_STYLE}
                        >
                          split
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); togglePayeeSplit(_id) }}
                          onMouseDown={e => e.stopPropagation()}
                          style={{ ...OVERLAY_BTN_STYLE, ...(payeeSplitIds.has(_id) ? { background: 'rgba(255,255,255,0.85)', color: '#333' } : {}) }}
                        >
                          payees
                        </button>
                      </>
                    )}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        </div>
      </div>

      {excluded.length > 0 && (
        <div style={{ marginTop: '8px', fontSize: '13px', color: '#777', display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '14px', rowGap: '4px' }}>
          <span>Not shown (net negative):</span>
          {excluded.map(({ name, boxName, boxId, value, isLumpSelf }) => (
            <span key={`${boxId}:${name}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {name}{boxName !== name && <span style={{ color: '#aaa' }}> · {boxName}</span>} ({`-${dollarFormatter(-value)}`})
              {isLumpSelf && (
                <button onClick={() => toggleLump(boxId)} style={SMALL_BTN_STYLE}>
                  unlump
                </button>
              )}
            </span>
          ))}
        </div>
      )}

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
            onClick={() => { openSplitEditor(contextMenu.id); setContextMenu(null) }}
            style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: tree.get(contextMenu.id)?.childIds.length > 0 ? '1px solid #eee' : 'none' }}
          >
            Split...
          </div>
          {tree.get(contextMenu.id)?.childIds.length > 0 && (
            <div
              onClick={() => {
                onAbsorbChildren(contextMenu.id)
                setContextMenu(null)
              }}
              style={{ padding: '8px 16px', cursor: 'pointer', color: '#c0392b' }}
            >
              Absorb children
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', marginTop: '24px' }}>
        <table style={{ fontSize: '13px', borderCollapse: 'collapse', flexShrink: 0, width: '460px' }}>
          <thead>
            <tr style={{ background: '#2c3e50', color: '#fff' }}>
              {[['Category', 'name', 'left'], ['Path', 'group', 'left'], ['Spending', 'value', 'right'], ['Share', 'share', 'right']].map(([label, key, align]) => (
                <th
                  key={key}
                  onClick={() => setTableSort(prev => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }))}
                  style={{ padding: '8px 12px', textAlign: align, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                >
                  {label}
                  {tableSort.key === key && <span style={{ marginLeft: '4px', opacity: 0.8 }}>{tableSort.dir === 'desc' ? '▼' : '▲'}</span>}
                </th>
              ))}
              <th style={{ padding: '8px 12px' }} />
            </tr>
          </thead>
          <tbody>
            {sortedAllData.map(({ id, name, group, value, colorIndex }, i) => {
              const hidden    = hiddenIds.has(id)
              const children  = mergeChildren.get(id) ?? []
              const matches   = !catSearch || name.toLowerCase().includes(catSearch.toLowerCase())
              return (
                <Fragment key={id}>
                  <tr
                    onClick={() => selectCell(id, null)}
                    style={{ cursor: 'pointer', background: selectedId === id ? '#e3f2fd' : matches && catSearch ? '#fffde7' : hidden ? '#f0f0f0' : (i % 2 === 0 ? '#fff' : '#f4f6f8'), opacity: catSearch && !matches ? 0.3 : 1 }}
                  >
                    <td style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px', opacity: hidden ? 0.4 : 1 }}>
                      <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: COLORS[colorIndex % COLORS.length], flexShrink: 0 }} />
                      {name}
                    </td>
                    <td style={{ padding: '6px 12px', color: '#777', opacity: hidden ? 0.4 : 1 }}>{group}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', opacity: hidden ? 0.4 : 1 }}>{dollarFormatter(value)}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: '#777', opacity: hidden ? 0.4 : 1 }}>
                      {hidden ? '—' : `${((value / grandTotal) * 100).toFixed(1)}%`}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                      <button
                        onClick={e => { e.stopPropagation(); toggleHidden(id) }}
                        style={SMALL_BTN_STYLE}
                      >
                        {hidden ? 'show' : 'hide'}
                      </button>
                    </td>
                  </tr>
                  {children.map(child => {
                    const spend = childTotals.get(child.id) ?? 0
                    return (
                      <tr key={child.id} style={{ background: hidden ? '#f0f0f0' : (i % 2 === 0 ? '#f8f8f8' : '#efefef'), opacity: hidden ? 0.4 : 1 }}>
                        <td style={{ padding: '4px 12px 4px 28px', display: 'flex', alignItems: 'center', gap: '8px', color: '#555' }}>
                          <span style={{ color: '#bbb' }}>—</span>
                          {child.name}
                        </td>
                        <td />
                        <td style={{ padding: '4px 12px', textAlign: 'right', color: '#555' }}>{dollarFormatter(spend)}</td>
                        <td style={{ padding: '4px 12px', textAlign: 'right', color: '#999' }}>
                          {((spend / grandTotal) * 100).toFixed(1)}%
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                          <button
                            onClick={() => onUnmergeNode(child.id)}
                            style={SMALL_BTN_STYLE}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexShrink: 0, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: '14px', color: '#2c3e50' }}>
                Split: <em style={{ fontWeight: 400 }}>{editingSplit.sourceName}</em>
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#555', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={editingSplit.automatic}
                  onChange={() => setEditingSplit(prev => {
                    const automatic = !prev.automatic
                    if (automatic && prev.manualKeys.size > 0) {
                      const reclassified = classifyAll(splitEditorRows, prev.assignments, prev.manualKeys, prev.parts.length)
                      return { ...prev, automatic, assignments: reclassified ?? prev.assignments }
                    }
                    return { ...prev, automatic }
                  })}
                />
                Automatic
              </label>
              <button
                onClick={() => setEditingSplit(prev => ({ ...prev, parts: [...prev.parts, ''] }))}
                style={SMALL_BTN_STYLE}
              >+ Add part</button>
              <button
                onClick={saveSplit}
                style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #27ae60', borderRadius: '3px', background: '#27ae60', color: '#fff' }}
              >Save</button>
              <button
                onClick={closeSplitEditor}
                style={{ ...SMALL_BTN_STYLE, marginLeft: 'auto' }}
              >Cancel</button>
            </div>
            <div style={{ display: 'flex', gap: '10px', flex: 1, minHeight: 0 }}>
              {editingSplit.parts.map((part, partIdx) => {
                const partRows = splitEditorRows.filter(r =>
                  (editingSplit.assignments[`${r._txId}/${r._subTxId}`] ?? 0) === partIdx
                )
                const partKeys = partRows.map(r => `${r._txId}/${r._subTxId}`)
                return (
                  <div
                    key={partIdx}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault()
                      const key = e.dataTransfer.getData('text/plain')
                      if (!key) return
                      const keys = splitSelectedKeys.has(key) ? [...splitSelectedKeys] : [key]
                      assignToSplitPart(keys, partIdx)
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', paddingLeft: '2px' }}>
                        <span style={{ fontSize: '12px', color: '#27ae60', fontWeight: 600 }}>
                          {dollarFormatter(splitPartTotals[partIdx] ?? 0)}
                          <span style={{ fontWeight: 400, color: '#999', marginLeft: '6px' }}>{partRows.length} transactions</span>
                        </span>
                        {splitSelectedKeys.size > 0 && (
                          <button
                            onClick={() => assignToSplitPart([...splitSelectedKeys], partIdx)}
                            style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #2980b9', borderRadius: '3px', background: '#2980b9', color: '#fff' }}
                          >
                            Assign {splitSelectedKeys.size} here
                          </button>
                        )}
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
                      {partRows.map((row, rowIdx) => {
                        const key = `${row._txId}/${row._subTxId}`
                        const isManual = editingSplit.manualKeys.has(key)
                        const isSelected = splitSelectedKeys.has(key)
                        const isFocused = splitFocusedKey === key
                        return (
                          <div
                            key={key}
                            draggable
                            onDragStart={e => e.dataTransfer.setData('text/plain', key)}
                            onClick={e => {
                              if (e.shiftKey && splitFocusedKey) {
                                // range-select from focused key to this key within the column
                                const focusIdx = partKeys.indexOf(splitFocusedKey)
                                const lo = Math.min(focusIdx, rowIdx)
                                const hi = Math.max(focusIdx, rowIdx)
                                setSplitSelectedKeys(prev => new Set([...prev, ...partKeys.slice(lo, hi + 1)]))
                              } else {
                                setSplitSelectedKeys(new Set([key]))
                              }
                              setSplitFocusedKey(key)
                            }}
                            style={{
                              padding: '6px 8px',
                              marginBottom: '4px',
                              background: isSelected ? '#e3f2fd' : isManual ? '#e8f5e9' : '#fff',
                              border: `1px solid ${isSelected ? '#90caf9' : isManual ? '#81c784' : '#ddd'}`,
                              outline: isFocused ? '2px solid #2980b9' : 'none',
                              outlineOffset: '-2px',
                              borderRadius: '4px',
                              cursor: 'grab',
                              fontSize: '12px',
                              userSelect: 'none',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {
                                  setSplitSelectedKeys(prev => {
                                    const next = new Set(prev)
                                    next.has(key) ? next.delete(key) : next.add(key)
                                    return next
                                  })
                                  setSplitFocusedKey(key)
                                }}
                                onClick={e => e.stopPropagation()}
                                style={{ flexShrink: 0, cursor: 'pointer' }}
                              />
                              <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                {row['Payee']}
                              </div>
                            </div>
                            {row['Memo'] && (
                              <div style={{ fontSize: '11px', color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: '22px', marginTop: '1px' }}>
                                {row['Memo']}
                              </div>
                            )}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', color: '#888', paddingLeft: '22px' }}>
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
        ) : selectedId ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '8px', color: '#2c3e50', display: 'flex', alignItems: 'baseline', gap: '12px' }}>
              {tree.get(selectedId)?.name}
              {selectedPayee && (
                <span style={{ fontWeight: 400, fontSize: '12px', color: '#888' }}>· {selectedPayee}</span>
              )}
              {ancestorNames(selectedId).length > 0 && (
                <span style={{ fontWeight: 400, fontSize: '12px', color: '#888' }}>in {ancestorNames(selectedId).join(' / ')}</span>
              )}
              <span style={{ fontWeight: 400, fontSize: '13px', color: '#555' }}>{dollarFormatter(filteredRows.reduce((s, r) => s + netSpend(r), 0))}</span>
              <button onClick={() => toggleHidden(selectedId)} style={SMALL_BTN_STYLE}>
                {hiddenIds.has(selectedId) ? 'show' : 'hide'}
              </button>
              <button onClick={() => openSplitEditor(selectedId, detailSelectionRef.current)} style={SMALL_BTN_STYLE}>
                split
              </button>
              <button onClick={() => { setSelectedId(null); setSelectedPayee(null) }} style={{ ...SMALL_BTN_STYLE, marginLeft: 'auto' }}>✕</button>
            </div>
            <div style={{ height: '500px', border: '1px solid #ddd', borderRadius: '4px', overflow: 'hidden' }}>
              <TransactionsTab
                rows={filteredRows}
                catOptions={catOptions}
                onUpdateCategory={onUpdateCategory}
                onBulkUpdateCategory={onBulkUpdateCategory}
                onUpdateMemo={onUpdateMemo}
                isMainScenario={isMainScenario}
                hiddenCols={['Account', 'Inflow']}
                onSelectedChange={s => { detailSelectionRef.current = s }}
                columnLabels={{ Outflow: 'Net spend' }}
                columnValues={{ Outflow: r => {
                  const net = netSpend(r)
                  if (net === 0) return ''
                  return net > 0 ? dollarFormatter(net) : `-${dollarFormatter(-net)}`
                }}}
              />
            </div>
          </div>
        ) : null}
      </div>

    </div>
  )
}
