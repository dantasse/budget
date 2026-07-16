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

const ZOOM_MS = 300

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

function rowLabel(row) {
  return row['Category'] || row['Category Group']
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

export default function ReportsTab({ rows, budgetId, scenario, categoryGroups, catModel, mergeChildren, onUpdateCategory, onBulkUpdateCategory, onUpdateMemo, isMainScenario, onRenameGroup, onRenameCategory, onMoveCategory, onMergeCategory, onUnmergeCategory, onApplySplit, onRemoveSplit, onPushUndo, onRemoveUndos }) {
  // keyed by catId (post-refactor); the old name-keyed ynab_report_hidden_* keys are abandoned
  const hiddenKey  = `ynab_report_hiddenids_${budgetId}_${scenario}`
  const lumpsKey   = `ynab_report_lumps_${budgetId}_${scenario}`

  // hiddenCatIds: Set<catId> — categories excluded from the treemap
  const [hiddenCatIds, setHiddenCatIds] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(hiddenKey)) ?? []) }
    catch { return new Set() }
  })
  // lumpedGroups: Set<groupName> — groups displayed as a single cell instead of per-category cells
  const [lumpedGroups, setLumpedGroups] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(lumpsKey)) ?? []) }
    catch { return new Set() }
  })
  const [dragging,         setDragging]         = useState(null)
  const [dropTarget,       setDropTarget]       = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)
  // selectedPayee: narrows the detail panel to one payee within selectedCategory (set from zoomed payee boxes)
  const [selectedPayee,    setSelectedPayee]    = useState(null)
  const [editingGroup,     setEditingGroup]     = useState(null) // { name, value } | null
  const [contextMenu,      setContextMenu]      = useState(null) // { x, y, name } | null
  // editingSplit: { catName, parts, assignments, manualKeys, automatic } | null
  const [editingSplit,     setEditingSplit]     = useState(null)
  const [splitSelectedKeys, setSplitSelectedKeys] = useState(new Set())
  // splitFocusedKey: key of card with keyboard focus, for shift+up/down range-select
  const [splitFocusedKey,   setSplitFocusedKey]   = useState(null)
  const [groupPositions,   setGroupPositions]   = useState({})
  const [tableSort,        setTableSort]        = useState({ key: 'value', dir: 'desc' })
  // zoomedGroup: group name whose categories fill the treemap instead of the all-groups view
  const [zoomedGroup,      setZoomedGroup]      = useState(null)
  // payeeSplitCats: categories shown broken down by payee while zoomed (view-only, not persisted)
  const [payeeSplitCats,   setPayeeSplitCats]   = useState(new Set())
  // zoomAnim: { transform, transition } while the zoom in/out animation plays, else null
  const [zoomAnim,         setZoomAnim]         = useState(null)
  // the group-rect transform captured at zoom-in, replayed for the zoom-out animation
  const zoomTransformRef = useRef(null)
  const [dragLabel,        setDragLabel]        = useState(null) // { text, x, y, width, height } | null
  const [catSearch,        setCatSearch]        = useState('')
  const svgWrapperRef = useRef(null)
  // most-recent selection from the embedded detail-panel TransactionsTab; used to preload split parts
  const detailSelectionRef = useRef(new Set())

  useEffect(() => {
    localStorage.setItem(hiddenKey, JSON.stringify([...hiddenCatIds]))
  }, [hiddenCatIds, hiddenKey])

  useEffect(() => {
    localStorage.setItem(lumpsKey, JSON.stringify([...lumpedGroups]))
  }, [lumpedGroups, lumpsKey])

  // noData renders an early-return placeholder with no treemap wrapper, so the
  // observer must (re-)attach when data appears — with [] deps, mounting during
  // the initial fetch left it permanently unattached and the group labels never rendered
  const noData = rows.length === 0
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

  const toggleLump = useCallback((groupName) => {
    const wasLumped = lumpedGroups.has(groupName)
    onPushUndo({ label: wasLumped ? 'split' : 'lump', scope: 'reports', undo: () => setLumpedGroups(prev => {
      const next = new Set(prev)
      wasLumped ? next.add(groupName) : next.delete(groupName)
      return next
    })})
    setLumpedGroups(prev => {
      const next = new Set(prev)
      next.has(groupName) ? next.delete(groupName) : next.add(groupName)
      return next
    })
  }, [lumpedGroups, onPushUndo])

  const startZoom = (name) => {
    setZoomedGroup(name)
    const el  = svgWrapperRef.current
    const pos = groupPositions[name]
    if (!el || !pos) return // nothing to animate from; jump cut
    const { width: W, height: H } = el.getBoundingClientRect()
    const t = `translate(${pos.x}px, ${pos.y}px) scale(${pos.width / W}, ${pos.height / H})`
    zoomTransformRef.current = t
    setZoomAnim({ transform: t, transition: false })
    // two frames: first paints the shrunk state, second starts the transition
    requestAnimationFrame(() => requestAnimationFrame(() =>
      setZoomAnim({ transform: 'none', transition: true })))
    setTimeout(() => setZoomAnim(null), ZOOM_MS + 100)
  }

  const endZoom = () => {
    const t = zoomTransformRef.current
    if (!t) { setZoomedGroup(null); return } // no stored rect; jump cut
    setZoomAnim({ transform: t, transition: true })
    setTimeout(() => {
      setZoomedGroup(null)
      setZoomAnim(null)
    }, ZOOM_MS)
  }

  const togglePayeeSplit = useCallback((catName) => {
    const wasSplit = payeeSplitCats.has(catName)
    onPushUndo({ label: wasSplit ? 'lump' : 'split', scope: 'reports', undo: () => setPayeeSplitCats(prev => {
      const next = new Set(prev)
      wasSplit ? next.add(catName) : next.delete(catName)
      return next
    })})
    setPayeeSplitCats(prev => {
      const next = new Set(prev)
      next.has(catName) ? next.delete(catName) : next.add(catName)
      return next
    })
  }, [payeeSplitCats, onPushUndo])

  // this component's undo closures die with it, so drop them from the app stack on unmount
  useEffect(() => {
    return () => onRemoveUndos(e => e.scope === 'reports' || e.scope === 'splitEditor')
  }, [onRemoveUndos])

  // allData: rows arrive with merges/splits already resolved, so this is a plain
  // sum per display name; catId (first row's) drives the hide button
  const allData = useMemo(() => {
    const totals = new Map()
    const groupOf = new Map()
    const catIdOf = new Map()
    for (const row of rows) {
      const label = rowLabel(row)
      if (!label) continue
      const net = netSpend(row)
      if (net === 0) continue
      totals.set(label, (totals.get(label) ?? 0) + net)
      if (!groupOf.has(label)) groupOf.set(label, row['Category Group'] || '(none)')
      if (!catIdOf.has(label) && row._categoryId) catIdOf.set(label, row._categoryId)
    }
    return [...totals.entries()]
      .map(([name, value]) => ({ name, group: groupOf.get(name), catId: catIdOf.get(name), value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value)
      // colorIndex is fixed by the default (spending-desc) order so swatches don't change when re-sorting
      .map((d, i) => ({ ...d, colorIndex: i }))
  }, [rows])

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

  // childTotals: catId → net spend of rows that originally belonged to that
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

  // excludedGroups/excludedCats: cells the treemap drops because their net is
  // ≤ 0 — a lumped group collapses to one cell, so income inside it can sink
  // the whole group even when some of its categories have positive spending
  const { data: twoLevelData, excludedGroups, excludedCats } = useMemo(() => {
    const groupMap = new Map()
    const cellCatIds = new Map() // `${group} ${cat}` → catId (first row's)
    for (const row of rows) {
      const net = netSpend(row)
      if (net === 0) continue
      if (hiddenCatIds.has(row._categoryId)) continue
      const group = row['Category Group'] || '(none)'
      let effectiveCat = row['Category'] || group
      if (lumpedGroups.has(group)) effectiveCat = group
      else {
        const cellKey = `${group} ${effectiveCat}`
        if (!cellCatIds.has(cellKey)) cellCatIds.set(cellKey, row._categoryId)
      }
      if (!groupMap.has(group)) groupMap.set(group, new Map())
      groupMap.get(group).set(effectiveCat, (groupMap.get(group).get(effectiveCat) ?? 0) + net)
    }
    const excludedGroups = []
    const excludedCats = []
    const data = [...groupMap.entries()]
      .map(([gName, catMap], gi) => ({
        name: gName,
        groupColorIndex: gi,
        children: [...catMap.entries()]
          .map(([cName, value]) => ({
            name: cName,
            value: Math.round(value * 100) / 100,
            groupColorIndex: gi,
            // null for lumped-group cells, which don't represent one category
            _catId: cellCatIds.get(`${gName} ${cName}`) ?? null,
            _groupName: gName,
          }))
          .sort((a, b) => b.value - a.value),
      }))
      .map(g => {
        for (const c of g.children) {
          if (c.value > 0) continue
          if (lumpedGroups.has(g.name)) excludedGroups.push({ name: g.name, value: c.value })
          else excludedCats.push({ name: c.name, group: g.name, value: c.value })
        }
        return { ...g, children: g.children.filter(c => c.value > 0) }
      })
      .filter(g => g.children.length > 0)
      .sort((a, b) => {
        const aSum = a.children.reduce((s, c) => s + c.value, 0)
        const bSum = b.children.reduce((s, c) => s + c.value, 0)
        return bSum - aSum
      })
    excludedGroups.sort((a, b) => a.value - b.value)
    excludedCats.sort((a, b) => a.value - b.value)
    return { data, excludedGroups, excludedCats }
  }, [rows, hiddenCatIds, lumpedGroups])

  // zoomed view: categories of one group; a payee-split category gets one child per payee,
  // otherwise a single child spanning the whole category (mirrors twoLevelData's shape)
  const { data: zoomedData, excludedZoomCats } = useMemo(() => {
    if (!zoomedGroup) return { data: [], excludedZoomCats: [] }
    const catMap = new Map() // display cat name → Map<payee, total>
    const catIds = new Map() // display cat name → catId (first row's)
    for (const row of rows) {
      const net = netSpend(row)
      if (net === 0) continue
      if ((row['Category Group'] || '(none)') !== zoomedGroup) continue
      if (hiddenCatIds.has(row._categoryId)) continue
      const cat = row['Category'] || row['Category Group'] || '(none)'
      const payee = row['Payee'] || '(none)'
      if (!catMap.has(cat)) catMap.set(cat, new Map())
      if (!catIds.has(cat)) catIds.set(cat, row._categoryId)
      const pm = catMap.get(cat)
      pm.set(payee, (pm.get(payee) ?? 0) + net)
    }
    const excludedZoomCats = []
    const data = [...catMap.entries()]
      .map(([cName, payeeMap], ci) => {
        const total = [...payeeMap.values()].reduce((s, v) => s + v, 0)
        const children = (payeeSplitCats.has(cName)
          ? [...payeeMap.entries()].map(([pName, v]) => ({ name: pName, value: Math.round(v * 100) / 100, groupColorIndex: ci, _catName: cName, _isPayee: true }))
          : [{ name: cName, value: Math.round(total * 100) / 100, groupColorIndex: ci, _catName: cName, _isPayee: false }])
          .filter(c => c.value > 0)
          .sort((a, b) => b.value - a.value)
        if (children.length === 0) excludedZoomCats.push({ name: cName, value: Math.round(total * 100) / 100 })
        return { name: cName, groupColorIndex: ci, _catId: catIds.get(cName), children }
      })
      .filter(g => g.children.length > 0)
      .sort((a, b) => {
        const aSum = a.children.reduce((s, c) => s + c.value, 0)
        const bSum = b.children.reduce((s, c) => s + c.value, 0)
        return bSum - aSum
      })
    excludedZoomCats.sort((a, b) => a.value - b.value)
    return { data, excludedZoomCats }
  }, [zoomedGroup, rows, hiddenCatIds, payeeSplitCats])

  const filteredRows = useMemo(() => {
    if (!selectedCategory) return []
    const base = lumpedGroups.has(selectedCategory)
      ? rows.filter(r => (r['Category Group'] || '(none)') === selectedCategory)
      : rows.filter(r => rowLabel(r) === selectedCategory)
    if (!selectedPayee) return base
    return base.filter(r => (r['Payee'] || '(none)') === selectedPayee)
  }, [selectedCategory, selectedPayee, rows, lumpedGroups])

  // catId behind the current selection; null for lumped-group selections
  const selectedCatId = useMemo(() => {
    if (!selectedCategory || lumpedGroups.has(selectedCategory)) return null
    return filteredRows[0]?._categoryId ?? null
  }, [selectedCategory, lumpedGroups, filteredRows])

  const selectedSplitFrom = selectedCatId ? (catModel.cats[selectedCatId]?.splitFromName ?? null) : null

  const splitEditorRows = useMemo(() => {
    if (!editingSplit) return []
    return rows.filter(r => rowLabel(r) === editingSplit.catName)
      .sort((a, b) => (b['Date'] ?? '').localeCompare(a['Date'] ?? ''))
  }, [editingSplit?.catName, rows])

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

  const openSplitEditor = (catName, preassignedKeys) => {
    let assignments  = {}
    const manualKeys = new Set()
    const parts      = [catName, '']
    if (preassignedKeys && preassignedKeys.size > 0) {
      for (const k of preassignedKeys) {
        assignments[k] = 1
        manualKeys.add(k)
      }
      const editorRows = rows.filter(r => rowLabel(r) === catName)
      const reclassified = classifyAll(editorRows, assignments, manualKeys, parts.length)
      if (reclassified) assignments = reclassified
    }
    setEditingSplit({ catName, parts, assignments, manualKeys, automatic: true })
    onRemoveUndos(e => e.scope === 'splitEditor')
    setSplitSelectedKeys(new Set())
    setSplitFocusedKey(null)
    setSelectedCategory(null)
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
    const { parts, assignments } = editingSplit
    const validParts = parts.map(p => p.trim()).filter(Boolean)
    if (validParts.length < 2) return
    const sourceId = splitEditorRows[0]?._categoryId
    if (!sourceId) return
    onApplySplit(sourceId, validParts, assignments)
    closeSplitEditor()
  }

  // name → catId lookup for the currently dragged cell (drag state stores only the name)
  const catIdOfCell = (cellName) => {
    for (const g of twoLevelData) {
      const c = g.children.find(c => c.name === cellName)
      if (c) return c._catId
    }
    return null
  }

  const renderCell = ({ x, y, width, height, depth, name, value, groupColorIndex, _catId, _groupName }) => {
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
    // dropTarget === name        → merge mode (hovering over text label)
    // dropTarget === `grp:${name}` → group-move mode (hovering over background)
    const isDraggingThis = dragging === name
    // true when the dragged category already lives in this cell's group — group-move would be a no-op
    const sameGroup      = dragging && dragging !== name && twoLevelData.find(g => g.children.some(c => c.name === dragging))?.name === _groupName
    const isMergeTarget  = dropTarget === name           && dragging && dragging !== name
    const isGroupTarget  = dropTarget === `grp:${name}`  && dragging && dragging !== name && !sameGroup
    const showText       = width > 50  && height > 24
    const showValue      = width > 70  && height > 44
    const textY          = y + height/2 + (showValue ? -7 : 4)
    return (
      <g
        style={{ cursor: dragging ? (isDraggingThis ? 'grabbing' : 'copy') : 'pointer', userSelect: 'none' }}
        onMouseDown={e => { e.preventDefault(); setDragging(name) }}
        onMouseLeave={() => {
          if (dropTarget === name || dropTarget === `grp:${name}`) setDropTarget(null)
          setDragLabel(null)
        }}
        onMouseUp={() => {
          if (dragging && dragging !== name) {
            // ops push their own undo snapshots in App; lumped cells have no
            // _catId, so drops from/onto them are no-ops
            const fromId = catIdOfCell(dragging)
            if (fromId && (dropTarget === name || sameGroup)) {
              if (_catId) onMergeCategory(fromId, _catId)
            } else if (fromId) {
              onMoveCategory(fromId, _groupName)
            }
            setDragging(null)
            setDropTarget(null)
            setDragLabel(null)
          } else if (dragging === name) {
            setSelectedCategory(prev => prev === name ? null : name)
            setSelectedPayee(null)
            closeSplitEditor()
            setDragging(null)
          }
        }}
        onContextMenu={e => {
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY, name, catId: _catId })
          setEditingGroup(null)
        }}
      >
        {/* background rect: drop here = move to this group */}
        <rect
          x={x} y={y} width={width} height={height}
          fill={color} stroke="#fff"
          strokeWidth={isMergeTarget || isGroupTarget ? 3 : 1}
          opacity={isDraggingThis ? 0.35 : 0.85}
          onMouseEnter={() => {
            if (dragging && dragging !== name) {
              if (sameGroup) {
                setDropTarget(name)
                setDragLabel({ text: `Merge with ${name}`, x, y, width, height })
              } else {
                setDropTarget(`grp:${name}`)
                const gPos = groupPositions[_groupName] ?? { x, y, width, height }
                setDragLabel({ text: `Move ${dragging} to ${_groupName}`, ...gPos })
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
              {name}
            </text>
            {/* invisible hit-zone over text label: drop here = merge (only when cross-group) */}
            <rect
              x={x + width * 0.1} y={textY - 11} width={width * 0.8} height={16}
              fill="transparent"
              style={{ pointerEvents: dragging && dragging !== name && !sameGroup ? 'auto' : 'none' }}
              onMouseEnter={() => {
                if (dragging && dragging !== name) {
                  setDropTarget(name)
                  setDragLabel({ text: `Merge with ${name}`, x, y, width, height })
                }
              }}
              onMouseLeave={() => {
                if (dropTarget === name && dragging && !sameGroup) {
                  setDropTarget(`grp:${name}`)
                  const gPos = groupPositions[_groupName] ?? { x, y, width, height }
                  setDragLabel({ text: `Move ${dragging} to ${_groupName}`, ...gPos })
                }
              }}
            />
          </>
        )}
        {showValue && !isDraggingThis && (
          <text x={x + width/2} y={y + height/2 + 10} textAnchor="middle" fill="#fff" fontSize={11} opacity={0.85} style={{ pointerEvents: 'none' }}>
            {dollarFormatter(value)}
          </text>
        )}
      </g>
    )
  }

  // zoomed-view cell: same visual language as renderCell; click opens the detail
  // panel (payee boxes narrow it to that payee), no drag/merge/context interactions
  const renderZoomCell = ({ x, y, width, height, depth, name, value, groupColorIndex, _catName, _isPayee }) => {
    if (depth === 0 || !width || !height || width < 2 || height < 2) return null
    const color = COLORS[groupColorIndex % COLORS.length]
    if (depth === 1) {
      return (
        <g style={{ pointerEvents: 'none' }}>
          <rect data-group-name={name} x={x} y={y} width={width} height={height} fill={color} stroke="#fff" strokeWidth={3} opacity={0.9} />
        </g>
      )
    }
    const showText  = width > 50 && height > 24
    const showValue = width > 70 && height > 44
    const textY     = y + height/2 + (showValue ? -7 : 4)
    const handleClick = () => {
      const payee = _isPayee ? name : null
      const same  = selectedCategory === _catName && selectedPayee === payee
      setSelectedCategory(same ? null : _catName)
      setSelectedPayee(same ? null : payee)
      closeSplitEditor()
    }
    return (
      <g onClick={handleClick} style={{ cursor: 'pointer' }}>
        <rect x={x} y={y} width={width} height={height} fill={color} stroke="#fff" strokeWidth={1} opacity={0.85} />
        {showText && (
          <text x={x + width/2} y={textY} textAnchor="middle" fill="#fff" fontSize={12} fontWeight={600} style={{ pointerEvents: 'none' }}>
            {name}
          </text>
        )}
        {showValue && (
          <text x={x + width/2} y={y + height/2 + 10} textAnchor="middle" fill="#fff" fontSize={11} opacity={0.85} style={{ pointerEvents: 'none' }}>
            {dollarFormatter(value)}
          </text>
        )}
      </g>
    )
  }

  const toggleHidden = (catId) =>
    setHiddenCatIds(prev => {
      const next = new Set(prev)
      next.has(catId) ? next.delete(catId) : next.add(catId)
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
        {zoomedGroup && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: '#2c3e50' }}>
            {zoomedGroup}
            <button onClick={endZoom} style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}>✕</button>
          </span>
        )}
        {dragging && (
          <span style={{ color: '#888', fontStyle: 'italic' }}>Drop to move to that group; drop on the text label to merge</span>
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
          <Treemap data={zoomedGroup ? zoomedData : twoLevelData} dataKey="value" content={zoomedGroup ? renderZoomCell : renderCell} isAnimationActive={false}>
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
          {(zoomedGroup ? zoomedData : twoLevelData).map(({ name, _catId }) => {
            const pos = groupPositions[name]
            if (!pos) return null
            const isEditing = editingGroup?.name === name
            // zoomed labels rename the category (by id); main-view labels rename the group (by name)
            const commitRename = (value) => {
              zoomedGroup ? onRenameCategory(_catId, value) : onRenameGroup(name, value)
              setEditingGroup(null)
            }
            return (
              <div
                key={name}
                data-label-for={name}
                onClick={() => { if (!isEditing && (!zoomedGroup || _catId)) setEditingGroup({ name, value: name }) }}
                style={{
                  position: 'absolute',
                  left: pos.x + 6,
                  top: pos.y + 4,
                  maxWidth: pos.width - 12,
                  pointerEvents: 'auto',
                  cursor: 'text',
                }}
              >
                {isEditing ? (
                  <input
                    autoFocus
                    value={editingGroup.value}
                    onChange={e => setEditingGroup(prev => ({ ...prev, value: e.target.value }))}
                    onBlur={() => commitRename(editingGroup.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter')  { e.stopPropagation(); commitRename(editingGroup.value) }
                      if (e.key === 'Escape') { e.stopPropagation(); setEditingGroup(null) }
                    }}
                    style={{ background: 'rgba(0,0,0,0.35)', border: 'none', outline: 'none', color: '#fff', fontSize: '12px', fontWeight: 700, fontFamily: 'sans-serif', width: '160px', padding: '0 2px', borderBottom: '1px solid rgba(255,255,255,0.7)' }}
                  />
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: '#fff', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', userSelect: 'none', textShadow: '0 1px 3px rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.3)' }}>
                      {name}
                    </span>
                    {zoomedGroup ? (
                      <button
                        onClick={e => { e.stopPropagation(); togglePayeeSplit(name) }}
                        onMouseDown={e => e.stopPropagation()}
                        style={OVERLAY_BTN_STYLE}
                      >
                        {payeeSplitCats.has(name) ? 'lump' : 'split'}
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={e => { e.stopPropagation(); toggleLump(name) }}
                          onMouseDown={e => e.stopPropagation()}
                          style={OVERLAY_BTN_STYLE}
                        >
                          {lumpedGroups.has(name) ? 'split' : 'lump'}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); startZoom(name) }}
                          onMouseDown={e => e.stopPropagation()}
                          style={OVERLAY_BTN_STYLE}
                        >
                          zoom
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

      {(zoomedGroup ? excludedZoomCats.length > 0 : excludedGroups.length > 0 || excludedCats.length > 0) && (
        <div style={{ marginTop: '8px', fontSize: '13px', color: '#777', display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '14px', rowGap: '4px' }}>
          <span>Not shown (net negative):</span>
          {!zoomedGroup && excludedGroups.map(({ name, value }) => (
            <span key={`grp:${name}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {name} ({`-${dollarFormatter(-value)}`})
              <button onClick={() => toggleLump(name)} style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}>
                split
              </button>
            </span>
          ))}
          {(zoomedGroup ? excludedZoomCats : excludedCats).map(({ name, group, value }) => (
            <span key={`cat:${group ?? ''}:${name}`}>
              {name}{group && <span style={{ color: '#aaa' }}> · {group}</span>} ({`-${dollarFormatter(-value)}`})
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
            onClick={() => { openSplitEditor(contextMenu.name); setContextMenu(null) }}
            style={{ padding: '8px 16px', cursor: 'pointer', borderBottom: catModel.cats[contextMenu.catId]?.splitFrom ? '1px solid #eee' : 'none' }}
          >
            Split...
          </div>
          {catModel.cats[contextMenu.catId]?.splitFrom && (
            <div
              onClick={() => {
                onRemoveSplit(catModel.cats[contextMenu.catId].splitFrom)
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
        <table style={{ fontSize: '13px', borderCollapse: 'collapse', flexShrink: 0, width: '460px' }}>
          <thead>
            <tr style={{ background: '#2c3e50', color: '#fff' }}>
              {[['Category', 'name', 'left'], ['Category Group', 'group', 'left'], ['Spending', 'value', 'right'], ['Share', 'share', 'right']].map(([label, key, align]) => (
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
            {sortedAllData.map(({ name, group, catId, value, colorIndex }, i) => {
              const hidden    = hiddenCatIds.has(catId)
              const children  = mergeChildren.get(name) ?? []
              const matches   = !catSearch || name.toLowerCase().includes(catSearch.toLowerCase())
              return (
                <Fragment key={name}>
                  <tr
                    onClick={() => {
                      setSelectedCategory(prev => prev === name ? null : name)
                      setSelectedPayee(null)
                      closeSplitEditor()
                    }}
                    style={{ cursor: 'pointer', background: selectedCategory === name ? '#e3f2fd' : matches && catSearch ? '#fffde7' : hidden ? '#f0f0f0' : (i % 2 === 0 ? '#fff' : '#f4f6f8'), opacity: catSearch && !matches ? 0.3 : 1 }}
                  >
                    <td style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px', opacity: hidden ? 0.4 : 1 }}>
                      <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: COLORS[colorIndex % COLORS.length], flexShrink: 0 }} />
                      {name}
                    </td>
                    <td style={{ padding: '6px 12px', color: '#777', opacity: hidden ? 0.4 : 1 }}>{group}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', opacity: hidden ? 0.4 : 1 }}>{dollarFormatter(value)}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: '#777', opacity: hidden ? 0.4 : 1 }}>
                      {hidden ? '—' : `${((value / total) * 100).toFixed(1)}%`}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                      <button
                        onClick={e => { e.stopPropagation(); toggleHidden(catId) }}
                        disabled={!catId}
                        style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555', opacity: catId ? 1 : 0.4 }}
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
                          {((spend / total) * 100).toFixed(1)}%
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                          <button
                            onClick={() => onUnmergeCategory(child.id)}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexShrink: 0, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: '14px', color: '#2c3e50' }}>
                Split: <em style={{ fontWeight: 400 }}>{editingSplit.catName}</em>
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
                style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}
              >+ Add part</button>
              <button
                onClick={saveSplit}
                style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #27ae60', borderRadius: '3px', background: '#27ae60', color: '#fff' }}
              >Save</button>
              <button
                onClick={closeSplitEditor}
                style={{ marginLeft: 'auto', fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}
              >Cancel</button>
            </div>
            <div style={{ display: 'flex', gap: '10px', flex: 1, minHeight: 0 }}>
              {editingSplit.parts.map((part, partIdx) => {
                const partRows = splitEditorRows.filter(r =>
                  (editingSplit.assignments[`${r._txId}/${r._subTxId}`] ?? 0) === partIdx
                )
                const partKeys = partRows.map(r => `${r._txId}/${r._subTxId}`)
                const selectedHere = partKeys.filter(k => splitSelectedKeys.has(k))
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
        ) : selectedCategory ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '8px', color: '#2c3e50', display: 'flex', alignItems: 'baseline', gap: '12px' }}>
              {selectedCategory}
              {selectedPayee && (
                <span style={{ fontWeight: 400, fontSize: '12px', color: '#888' }}>· {selectedPayee}</span>
              )}
              {selectedSplitFrom && (
                <span style={{ fontWeight: 400, fontSize: '12px', color: '#888' }}>ex {selectedSplitFrom}</span>
              )}
              <span style={{ fontWeight: 400, fontSize: '13px', color: '#555' }}>{dollarFormatter(filteredRows.reduce((s, r) => s + netSpend(r), 0))}</span>
              <button onClick={() => toggleHidden(selectedCatId)} disabled={!selectedCatId} style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555', opacity: selectedCatId ? 1 : 0.4 }}>
                {hiddenCatIds.has(selectedCatId) ? 'show' : 'hide'}
              </button>
              <button onClick={() => openSplitEditor(selectedCategory, detailSelectionRef.current)} style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: `1px solid ${selectedSplitFrom ? '#81c784' : '#bbb'}`, borderRadius: '3px', background: selectedSplitFrom ? '#e8f5e9' : '#f4f4f4', color: selectedSplitFrom ? '#27ae60' : '#555' }}>
                split
              </button>
              <button onClick={() => { setSelectedCategory(null); setSelectedPayee(null) }} style={{ marginLeft: 'auto', fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}>✕</button>
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
