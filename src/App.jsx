import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import TransactionsTab from './TransactionsTab'
import ReportsTab from './ReportsTab'
import CategoriesTab from './CategoriesTab'

const TABS = ['Transactions', 'Reports', 'Categories']
const API  = 'https://api.ynab.com/v1'
const MAIN = 'main'

const TAB_STYLE = (active) => ({
  padding: '8px 20px',
  cursor: 'pointer',
  border: 'none',
  borderBottom: active ? '2px solid #2c3e50' : '2px solid transparent',
  background: 'none',
  fontFamily: 'sans-serif',
  fontSize: '14px',
  fontWeight: active ? '600' : '400',
  color: active ? '#2c3e50' : '#777',
})

async function apiFetch(path, token, method = 'GET', body = null) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } }
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API}${path}`, opts)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error?.detail ?? `YNAB API ${res.status}`)
  }
  return res.json()
}

function toRows(transactions, catMap) {
  const rows = []
  for (const tx of transactions) {
    if (tx.deleted) continue
    const subs = tx.subtransactions?.filter(s => !s.deleted) ?? []
    const entries = subs.length > 0
      ? subs.map(s => ({ amount: s.amount, memo: s.memo, categoryId: s.category_id, subTxId: s.id }))
      : [{ amount: tx.amount, memo: tx.memo, categoryId: tx.category_id, subTxId: null }]
    for (const { amount, memo, categoryId, subTxId } of entries) {
      const cat = catMap.get(categoryId) ?? { group: '', name: '' }
      rows.push({
        _txId:            tx.id,
        _subTxId:         subTxId,
        _categoryId:      categoryId,
        'Account':        tx.account_name ?? '',
        'Date':           tx.date,
        'Payee':          tx.payee_name ?? '',
        'Category':       [cat.group, cat.name].filter(Boolean).join(' → '),
        'Memo':           memo ?? '',
        'Outflow':        amount < 0 ? (Math.abs(amount) / 1000).toFixed(2) : '0.00',
        'Inflow':         amount > 0 ? (amount / 1000).toFixed(2) : '0.00',
      })
    }
  }
  return rows
}

function applyEdits(baseRows, edits) {
  if (!edits || Object.keys(edits).length === 0) return baseRows
  return baseRows.map(r => {
    const edit = edits[`${r._txId}/${r._subTxId}`]
    return edit ? { ...r, ...edit } : r
  })
}

function memoEditsKey(budgetId, name)  { return `ynab_memoedits_${budgetId}_${name}` }
function scenariosListKey(budgetId)    { return `ynab_scenarios_${budgetId}` }
function catModelKey(budgetId, name)   { return `ynab_cattree_${budgetId}_${name}` }

function loadMemoEdits(budgetId, name) {
  try { return JSON.parse(localStorage.getItem(memoEditsKey(budgetId, name))) ?? {} }
  catch { return {} }
}

function saveMemoEdits(budgetId, name, edits) {
  localStorage.setItem(memoEditsKey(budgetId, name), JSON.stringify(edits))
}

// catModel: the scenario's category-tree overlay (see DATA_MODEL.md).
// nodes:  { [nodeId]: { name?, parentId?, merged?, deleted? } } — partial overrides for ynab ids
//         (merged = tombstone: absorbed into routes[id]; deleted = tombstone with
//         no destination), full definitions for local ids
// routes: { [ynabId]: nodeId } — that category's transactions display as nodeId
// txCats: { [txKey]: nodeId } — per-transaction exceptions
// Invariant: routes/txCats values always point at live node ids (ops flatten on write).
const EMPTY_CAT_MODEL = { nodes: {}, routes: {}, txCats: {} }

function loadCatModel(budgetId, name) {
  try {
    const m = JSON.parse(localStorage.getItem(catModelKey(budgetId, name)))
    return m ? { ...EMPTY_CAT_MODEL, ...m } : EMPTY_CAT_MODEL
  } catch { return EMPTY_CAT_MODEL }
}

function saveCatModel(budgetId, name, model) {
  localStorage.setItem(catModelKey(budgetId, name), JSON.stringify(model))
}

function newLocalId() { return `local:${crypto.randomUUID()}` }
function isLocalId(id) { return id.startsWith('local:') }

// walks parentIds; true when ancestorId is id or one of its ancestors
function inSubtree(tree, ancestorId, id) {
  let cur = tree.byId.get(id)
  while (cur) {
    if (cur.id === ancestorId) return true
    cur = cur.parentId !== null ? tree.byId.get(cur.parentId) : undefined
  }
  return false
}

function descendantIds(tree, id) {
  const out = []
  const visit = (nid) => {
    for (const c of tree.byId.get(nid).childIds) { out.push(c); visit(c) }
  }
  visit(id)
  return out
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function defaultStartDate() {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return isoDate(d)
}

function parsePath() {
  const segs = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  return { scenario: segs[0] ?? null, tab: segs[1] ?? null }
}

function loadScenariosList(budgetId) {
  try { return JSON.parse(localStorage.getItem(scenariosListKey(budgetId))) ?? [MAIN] }
  catch { return [MAIN] }
}

function saveScenariosList(budgetId, list) {
  localStorage.setItem(scenariosListKey(budgetId), JSON.stringify(list))
}

export default function App() {
  const [token,            setToken]            = useState(() => localStorage.getItem('ynab_token') ?? '')
  const [tokenInput,       setTokenInput]       = useState(() => localStorage.getItem('ynab_token') ?? '')
  const [budgets,          setBudgets]          = useState([])
  const [selectedBudgetId, setSelectedBudgetId] = useState(() => localStorage.getItem('ynab_budget_id') ?? '')
  const [categoryGroups,   setCategoryGroups]   = useState([])
  const [baseRows,         setBaseRows]         = useState([])
  const [scenarios,        setScenarios]        = useState([MAIN])
  const [activeScenario,   setActiveScenario]   = useState(MAIN)
  // memoEdits: { [txKey]: { Memo } } — per-row memo patches (category changes live in catModel)
  const [memoEdits,        setMemoEdits]        = useState({})
  const [catModel,         setCatModel]         = useState(EMPTY_CAT_MODEL)
  const [newScenarioInput, setNewScenarioInput] = useState(null) // null = hidden, string = visible
  // txSubsById: Map<txId, Array<{id, amount, category_id, memo}>> — full subtransaction list per split tx,
  // needed to reconstruct the complete array when patching a single subtransaction's category.
  const txSubsById = useRef(new Map())
  const [editLiveData,     setEditLiveData]     = useState(false)
  // app-wide undo stack; entries: { label?, scope, key?, undo }
  // scope: 'edits' (scenario edits) | 'reports' | 'splitEditor' — the latter two are pruned by ReportsTab
  const [undoStack,        setUndoStack]        = useState([])
  // count of in-flight loads: the budgets fetch and the transactions/categories
  // fetch overlap, so a boolean would go false when the first one settles
  const [loadingCount,     setLoadingCount]     = useState(0)
  const loading = loadingCount > 0
  // bumped by Connect so the fetch effects re-run even when the token is unchanged
  const [connectCount,     setConnectCount]     = useState(0)
  const [error,            setError]            = useState(null)
  // URL path is /{scenario}/{tab}; consumed once on initial budget load, then null.
  const urlPathRef = useRef(parsePath())
  const [activeTab,        setActiveTab]        = useState(() =>
    TABS.includes(urlPathRef.current.tab) ? urlPathRef.current.tab : 'Transactions')
  const [startDate,        setStartDate]        = useState(defaultStartDate)
  const [endDate,          setEndDate]          = useState(() => isoDate(new Date()))

  // catTree: the effective category tree = YNAB base + catModel.nodes overlay.
  // byId: Map<id, { id, name, parentId, childIds, hidden, ynab: 'group'|'category'|null }>
  // Tombstoned (merged/deleted) nodes are absent; orphans (parent missing) surface as roots.
  const catTree = useMemo(() => {
    const byId = new Map()
    for (const g of categoryGroups) {
      byId.set(g.id, { id: g.id, name: g.name, parentId: null, hidden: g.hidden, ynab: 'group' })
      for (const c of g.categories) {
        byId.set(c.id, { id: c.id, name: c.name, parentId: g.id, hidden: g.hidden || c.hidden, ynab: 'category' })
      }
    }
    for (const [id, ov] of Object.entries(catModel.nodes)) {
      if (ov.merged || ov.deleted) { byId.delete(id); continue }
      const base = byId.get(id)
      if (base) {
        byId.set(id, { ...base, name: ov.name ?? base.name, parentId: 'parentId' in ov ? ov.parentId : base.parentId })
      } else if (isLocalId(id)) {
        byId.set(id, { id, name: ov.name, parentId: ov.parentId ?? null, hidden: false, ynab: null })
      }
      // an override for a ynab id we no longer know (deleted in YNAB) is dropped
    }
    const rootIds = []
    for (const n of byId.values()) n.childIds = []
    for (const n of byId.values()) {
      const parent = n.parentId !== null ? byId.get(n.parentId) : undefined
      parent ? parent.childIds.push(n.id) : rootIds.push(n.id)
    }
    return { byId, rootIds }
  }, [categoryGroups, catModel.nodes])

  // nodePaths: id → array of node names, root → node; missing for unknown ids
  const nodePaths = useMemo(() => {
    const cache = new Map()
    const walk = (id, seen) => {
      if (cache.has(id)) return cache.get(id)
      const n = catTree.byId.get(id)
      if (!n) return undefined
      if (seen.has(id)) {
        console.error('category tree cycle at', id)
        return [n.name]
      }
      seen.add(id)
      const parentPath = n.parentId !== null ? walk(n.parentId, seen) : undefined
      const path = parentPath ? [...parentPath, n.name] : [n.name]
      cache.set(id, path)
      return path
    }
    for (const id of catTree.byId.keys()) walk(id, new Set())
    return cache
  }, [catTree])

  // ynabNames: original YNAB names, kept for ids no longer in the tree (merge tombstones)
  const ynabNames = useMemo(() => {
    const m = new Map()
    for (const g of categoryGroups) {
      m.set(g.id, g.name)
      for (const c of g.categories) m.set(c.id, c.name)
    }
    return m
  }, [categoryGroups])

  // allRows: every transaction with memo edits applied and its category resolved
  // through the scenario's catModel; rows: allRows narrowed to the date pickers.
  // Rows leave here final — tabs never re-resolve categories.
  const allRows = useMemo(() => {
    const withMemos = applyEdits(baseRows, memoEdits)
    const { routes, txCats } = catModel
    return withMemos.map(row => {
      const key = `${row._txId}/${row._subTxId}`
      const nodeId = txCats[key] ?? routes[row._categoryId] ?? row._categoryId
      const path = nodePaths.get(nodeId)
      // unknown id (e.g., a category deleted in YNAB): keep the row's stamped names
      if (!path) return row
      return {
        ...row,
        // _ynabCategoryId preserves the pre-resolution id (used for merge-child totals)
        ...(nodeId !== row._categoryId ? { _ynabCategoryId: row._categoryId } : {}),
        _categoryId: nodeId,
        _path: path,
        'Category': path.join(' → '),
      }
    })
  }, [baseRows, memoEdits, catModel, nodePaths])
  // an empty (cleared) date input means that bound is unlimited
  const rows = allRows.filter(r =>
    (!startDate || r['Date'] >= startDate) && (!endDate || r['Date'] <= endDate))

  useEffect(() => {
    if (!token) return
    setLoadingCount(c => c + 1)
    setError(null)
    apiFetch('/budgets', token)
      .then(({ data }) => setBudgets(data.budgets))
      .catch(e => setError(e.message))
      .finally(() => setLoadingCount(c => c - 1))
  }, [token, connectCount])

  useEffect(() => {
    if (!token || !selectedBudgetId) return
    setLoadingCount(c => c + 1)
    setError(null)
    const loadedScenarios = loadScenariosList(selectedBudgetId)
    setScenarios(loadedScenarios)
    const { scenario: urlScenario, tab: urlTab } = urlPathRef.current
    urlPathRef.current = { scenario: null, tab: null }
    if (urlTab !== null && !TABS.includes(urlTab))
      setError(`Tabula “${urlTab}” non inventa est.`)
    if (urlScenario !== null && !loadedScenarios.includes(urlScenario))
      setError(`Scaenarium “${urlScenario}” non inventum est.`)
    const defaultScenario = loadedScenarios.includes(urlScenario)
      ? urlScenario
      : loadedScenarios.find(s => s !== MAIN) ?? MAIN
    setActiveScenario(defaultScenario)
    setMemoEdits(loadMemoEdits(selectedBudgetId, defaultScenario))
    setCatModel(loadCatModel(selectedBudgetId, defaultScenario))
    Promise.all([
      // without since_date the API silently returns only the last 1 year of transactions
      apiFetch(`/budgets/${selectedBudgetId}/transactions?since_date=2000-01-01`, token),
      apiFetch(`/budgets/${selectedBudgetId}/categories`, token),
    ])
      .then(([txData, catData]) => {
        const catMap = new Map()
        for (const group of catData.data.category_groups) {
          for (const cat of group.categories) {
            catMap.set(cat.id, { group: group.name, name: cat.name })
          }
        }
        // hidden groups/categories stay in the tree (flagged) so their
        // transactions still display; deleted ones are dropped
        setCategoryGroups(
          catData.data.category_groups
            .filter(g => !g.deleted)
            .map(g => ({
              id: g.id,
              name: g.name,
              hidden: g.hidden,
              categories: g.categories.filter(c => !c.deleted).map(c => ({ id: c.id, name: c.name, hidden: c.hidden })),
            }))
        )
        const newTxSubsById = new Map()
        for (const tx of txData.data.transactions) {
          if (tx.deleted) continue
          const subs = tx.subtransactions?.filter(s => !s.deleted) ?? []
          if (subs.length > 0)
            newTxSubsById.set(tx.id, subs.map(s => ({ id: s.id, amount: s.amount, category_id: s.category_id, memo: s.memo })))
        }
        txSubsById.current = newTxSubsById
        setBaseRows(toRows(txData.data.transactions, catMap))
      })
      .catch(e => setError(e.message))
      .finally(() => setLoadingCount(c => c - 1))
  }, [token, selectedBudgetId, connectCount])

  useEffect(() => {
    if (!selectedBudgetId) return
    const path = `/${encodeURIComponent(activeScenario)}/${encodeURIComponent(activeTab)}`
    if (window.location.pathname !== path) window.history.replaceState(null, '', path)
  }, [selectedBudgetId, activeScenario, activeTab])

  const handleConnect = (e) => {
    e.preventDefault()
    const t = tokenInput.trim()
    if (!t) return
    localStorage.setItem('ynab_token', t)
    setToken(t)
    setConnectCount(c => c + 1)
    setBaseRows([])
    setBudgets([])
  }

  const handleBudgetChange = (e) => {
    const id = e.target.value
    localStorage.setItem('ynab_budget_id', id)
    setSelectedBudgetId(id)
    setBaseRows([])
    setUndoStack([])
  }

  const handleScenarioChange = (e) => {
    const name = e.target.value
    if (name === '__new__') {
      setNewScenarioInput('')
      return
    }
    setActiveScenario(name)
    setMemoEdits(selectedBudgetId ? loadMemoEdits(selectedBudgetId, name) : {})
    setCatModel(selectedBudgetId ? loadCatModel(selectedBudgetId, name) : EMPTY_CAT_MODEL)
    setEditLiveData(false)
    setUndoStack([])
  }

  const handleCreateScenario = (e) => {
    e.preventDefault()
    const name = newScenarioInput.trim()
    if (!name || scenarios.includes(name)) return
    const next = [...scenarios, name]
    setScenarios(next)
    saveScenariosList(selectedBudgetId, next)
    setActiveScenario(name)
    setMemoEdits({})
    setCatModel(EMPTY_CAT_MODEL)
    setNewScenarioInput(null)
    setEditLiveData(false)
    setUndoStack([])
  }

  // catOptions: the tree flattened depth-first for the category pickers —
  // every node at every depth is assignable; hidden YNAB nodes are excluded
  const catOptions = useMemo(() => {
    const out = []
    const visit = (id, depth, ancestors) => {
      const n = catTree.byId.get(id)
      const path = [...ancestors, n.name]
      if (!n.hidden) out.push({ id, name: n.name, depth, path })
      for (const c of n.childIds) visit(c, depth + 1, path)
    }
    for (const id of catTree.rootIds) visit(id, 0, [])
    return out
  }, [catTree])

  // mergeChildren: live node id → [{ id, name }] of YNAB nodes merged into it
  // (split routes don't appear: they target a child of the source, no tombstone)
  const mergeChildren = useMemo(() => {
    const byParent = new Map()
    for (const [id, ov] of Object.entries(catModel.nodes)) {
      if (!ov.merged) continue
      const into = catModel.routes[id]
      if (!byParent.has(into)) byParent.set(into, [])
      byParent.get(into).push({ id, name: ynabNames.get(id) ?? id })
    }
    return byParent
  }, [catModel, ynabNames])

  function buildSplitBody(txId, changedSubIds, patch) {
    const allSubs = txSubsById.current.get(txId) ?? []
    const updated = allSubs.map(s =>
      changedSubIds.has(s.id) ? { ...s, ...patch } : s
    )
    return { transaction: { subtransactions: updated } }
  }

  function applySubsUpdate(txId, changedSubIds, patch) {
    const allSubs = txSubsById.current.get(txId) ?? []
    txSubsById.current.set(txId, allSubs.map(s =>
      changedSubIds.has(s.id) ? { ...s, ...patch } : s
    ))
  }

  function updateMemoEdits(updater) {
    setMemoEdits(prev => {
      const next = updater(prev)
      saveMemoEdits(selectedBudgetId, activeScenario, next)
      return next
    })
  }

  const pushUndo = useCallback((entry) => {
    setUndoStack(prev => [...prev, entry])
  }, [])

  // removes matching entries anywhere in the stack (re-merge dedup, ungroup, split-editor close/unmount)
  const removeUndos = useCallback((match) => {
    setUndoStack(prev => prev.filter(e => !match(e)))
  }, [])

  const pushMemoSnapshot = (keys) => {
    // live edits go to YNAB API and can't be reverted locally
    if (activeScenario === MAIN) return
    const prevEdits = {}
    for (const key of keys) {
      if (key in memoEdits) prevEdits[key] = memoEdits[key]
    }
    // captured now: the stack is cleared on budget/scenario change, so these stay valid
    const budgetId = selectedBudgetId
    const scenario = activeScenario
    pushUndo({ scope: 'edits', undo: () => {
      setMemoEdits(current => {
        const next = { ...current }
        for (const key of keys) {
          key in prevEdits ? (next[key] = prevEdits[key]) : delete next[key]
        }
        saveMemoEdits(budgetId, scenario, next)
        return next
      })
    }})
  }

  // every category op goes through here: guard, snapshot-undo, persist.
  // mutate(model) returns the next model, or the same reference for a no-op.
  const applyCatOp = (label, mutate) => {
    if (activeScenario === MAIN && !editLiveData) return
    const prev = catModel
    const next = mutate(prev)
    if (next === prev) return
    const budgetId = selectedBudgetId
    const scenario = activeScenario
    pushUndo({ label, scope: 'edits', undo: () => {
      saveCatModel(budgetId, scenario, prev)
      setCatModel(prev)
    }})
    saveCatModel(budgetId, scenario, next)
    setCatModel(next)
  }

  const handleUndo = useCallback(() => {
    const last = undoStack[undoStack.length - 1]
    if (!last) return
    last.undo()
    setUndoStack(prev => prev.slice(0, -1))
  }, [undoStack])

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

  const renameNode = (id, newName) => {
    const trimmed = newName.trim()
    if (!trimmed) return
    applyCatOp(undefined, model => {
      const node = catTree.byId.get(id)
      if (!node || node.name === trimmed) return model
      return { ...model, nodes: { ...model.nodes, [id]: { ...model.nodes[id], name: trimmed } } }
    })
  }

  // newParentId null = make the node a root
  const moveNode = (id, newParentId) => {
    applyCatOp('move', model => {
      const node = catTree.byId.get(id)
      if (!node || node.parentId === newParentId || id === newParentId) return model
      if (newParentId !== null && !catTree.byId.has(newParentId)) return model
      if (newParentId !== null && inSubtree(catTree, id, newParentId)) {
        setError(`Can't move “${node.name}” into its own subtree.`)
        return model
      }
      return { ...model, nodes: { ...model.nodes, [id]: { ...model.nodes[id], parentId: newParentId } } }
    })
  }

  const mergeNode = (fromId, intoId) => {
    applyCatOp('merge', model => {
      const from = catTree.byId.get(fromId)
      if (!from || fromId === intoId || !catTree.byId.has(intoId)) return model
      if (inSubtree(catTree, fromId, intoId)) {
        setError(`Can't merge “${from.name}” into its own subtree.`)
        return model
      }
      const nodes = { ...model.nodes }
      for (const childId of from.childIds) {
        nodes[childId] = { ...nodes[childId], parentId: intoId }
      }
      const routes = { ...model.routes }
      const txCats = { ...model.txCats }
      // flatten: anything pointing at fromId now points at intoId
      for (const [k, v] of Object.entries(routes)) if (v === fromId) routes[k] = intoId
      for (const [k, v] of Object.entries(txCats)) if (v === fromId) txCats[k] = intoId
      if (isLocalId(fromId)) delete nodes[fromId]
      else { nodes[fromId] = { merged: true }; routes[fromId] = intoId }
      return { nodes, routes, txCats }
    })
  }

  const unmergeNode = (fromId) => {
    applyCatOp(undefined, model => {
      if (!model.nodes[fromId]?.merged) return model
      const nodes = { ...model.nodes }
      delete nodes[fromId]
      const routes = { ...model.routes }
      delete routes[fromId]
      return { ...model, nodes, routes }
    })
  }

  const splitNode = (sourceId, partNames, assignments) => {
    // assignments: { [txKey]: partIdx }; unassigned rows (and future
    // transactions) follow the route to part 0. Parts become children of the
    // source, which stays in the tree as their parent.
    applyCatOp('split', model => {
      const source = catTree.byId.get(sourceId)
      if (!source) return model
      const partIds = partNames.map(() => newLocalId())
      const nodes = { ...model.nodes }
      partNames.forEach((name, i) => { nodes[partIds[i]] = { name, parentId: sourceId } })
      const routes = { ...model.routes }
      const txCats = { ...model.txCats }
      // flatten: anything pointing at the source now points at part 0
      for (const [k, v] of Object.entries(routes)) if (v === sourceId) routes[k] = partIds[0]
      for (const [k, v] of Object.entries(txCats)) if (v === sourceId) txCats[k] = partIds[0]
      // only ynab categories appear as raw transaction category ids; group/local
      // sources receive transactions via routes/txCats only (rewritten above)
      if (source.ynab === 'category') routes[sourceId] = partIds[0]
      for (const [key, partIdx] of Object.entries(assignments)) {
        if (partIdx > 0 && partIds[partIdx]) txCats[key] = partIds[partIdx]
      }
      return { nodes, routes, txCats }
    })
  }

  // the inverse of split, generalized: every descendant merges into the node
  // (local descendants deleted, ynab descendants tombstoned + routed)
  const absorbChildren = (id) => {
    applyCatOp('absorb', model => {
      const node = catTree.byId.get(id)
      if (!node || node.childIds.length === 0) return model
      const desc = new Set(descendantIds(catTree, id))
      const nodes = { ...model.nodes }
      const routes = {}
      for (const [k, v] of Object.entries(model.routes)) {
        const target = desc.has(v) ? id : v
        if (k !== target) routes[k] = target // a route from the node to one of its own parts folds away
      }
      const txCats = {}
      for (const [k, v] of Object.entries(model.txCats)) txCats[k] = desc.has(v) ? id : v
      for (const d of desc) {
        if (isLocalId(d)) delete nodes[d]
        else { nodes[d] = { merged: true }; routes[d] = id }
      }
      return { nodes, routes, txCats }
    })
  }

  // removes the node and its whole subtree. Their transactions revert to their
  // raw YNAB category, which is tombstoned and so unknown to the tree: they keep
  // their stamped names in Transactions and are skipped by Reports.
  const deleteNode = (id) => {
    applyCatOp('delete', model => {
      if (!catTree.byId.has(id)) return model
      const idSet = new Set([id, ...descendantIds(catTree, id)])
      const nodes = { ...model.nodes }
      const routes = {}
      for (const [k, v] of Object.entries(model.routes)) {
        if (idSet.has(k) || idSet.has(v)) {
          // a category merged into the deleted subtree goes down with it
          if (nodes[k]?.merged) nodes[k] = { deleted: true }
          continue
        }
        routes[k] = v
      }
      const txCats = {}
      for (const [k, v] of Object.entries(model.txCats)) if (!idSet.has(v)) txCats[k] = v
      for (const d of idSet) {
        if (isLocalId(d)) delete nodes[d]
        else nodes[d] = { deleted: true }
      }
      return { nodes, routes, txCats }
    })
  }

  const recategorizeTx = (keys, catId) => {
    applyCatOp(undefined, model => {
      const txCats = { ...model.txCats }
      for (const k of keys) txCats[k] = catId
      return { ...model, txCats }
    })
  }

  // after a live PATCH, any txCats override for those keys is stale (it would
  // shadow the new live category) and gets dropped
  const clearTxCats = (keys) => {
    if (!keys.some(k => k in catModel.txCats)) return
    applyCatOp(undefined, model => {
      const txCats = { ...model.txCats }
      for (const k of keys) delete txCats[k]
      return { ...model, txCats }
    })
  }

  const updateCategory = async (txId, subTxId, newCategoryId) => {
    if (activeScenario === MAIN && !editLiveData) return
    const key = `${txId}/${subTxId}`

    // only a real YNAB category can be PATCHed live; other nodes (local,
    // depth-1) have no YNAB equivalent and go through main's catModel
    if (activeScenario !== MAIN || catTree.byId.get(newCategoryId)?.ynab !== 'category') {
      recategorizeTx([key], newCategoryId)
      return
    }

    const apiPatch = { category_id: newCategoryId }
    const body = subTxId
      ? buildSplitBody(txId, new Set([subTxId]), apiPatch)
      : { transaction: apiPatch }
    try {
      await apiFetch(`/budgets/${selectedBudgetId}/transactions/${txId}`, token, 'PATCH', body)
      if (subTxId) applySubsUpdate(txId, new Set([subTxId]), apiPatch)
      setBaseRows(prev => prev.map(row => {
        if (row._txId !== txId) return row
        if (subTxId !== null && row._subTxId !== subTxId) return row
        return { ...row, _categoryId: newCategoryId }
      }))
      clearTxCats([key])
    } catch (e) {
      setError(e.message)
    }
  }

  const bulkUpdateCategory = async (rowKeys, newCategoryId) => {
    if (activeScenario === MAIN && !editLiveData) return

    if (activeScenario !== MAIN || catTree.byId.get(newCategoryId)?.ynab !== 'category') {
      recategorizeTx(rowKeys, newCategoryId)
      return
    }

    const keySet = new Set(rowKeys)
    const selected = baseRows.filter(r => keySet.has(`${r._txId}/${r._subTxId}`))
    const nonSplit  = selected.filter(r => r._subTxId === null)
    const split     = selected.filter(r => r._subTxId !== null)

    // Group split rows by txId so we send one PATCH per parent transaction
    const splitByTx = new Map()
    for (const r of split) {
      if (!splitByTx.has(r._txId)) splitByTx.set(r._txId, new Set())
      splitByTx.get(r._txId).add(r._subTxId)
    }

    const apiPatch = { category_id: newCategoryId }
    try {
      await Promise.all([
        nonSplit.length > 0 && apiFetch(`/budgets/${selectedBudgetId}/transactions`, token, 'PATCH', {
          transactions: nonSplit.map(r => ({ id: r._txId, ...apiPatch })),
        }),
        ...[...splitByTx.entries()].map(([txId, subIds]) =>
          apiFetch(`/budgets/${selectedBudgetId}/transactions/${txId}`, token, 'PATCH',
            buildSplitBody(txId, subIds, apiPatch))
        ),
      ].filter(Boolean))
      for (const [txId, subIds] of splitByTx) applySubsUpdate(txId, subIds, apiPatch)
      setBaseRows(prev => prev.map(row => {
        if (!keySet.has(`${row._txId}/${row._subTxId}`)) return row
        return { ...row, _categoryId: newCategoryId }
      }))
      clearTxCats(rowKeys)
    } catch (e) {
      setError(e.message)
    }
  }

  const updateMemo = async (txId, subTxId, newMemo) => {
    if (activeScenario === MAIN && !editLiveData) return
    pushMemoSnapshot([`${txId}/${subTxId}`])
    const rowPatch = { 'Memo': newMemo }
    const key = `${txId}/${subTxId}`

    if (activeScenario !== MAIN) {
      updateMemoEdits(prev => ({ ...prev, [key]: { ...prev[key], ...rowPatch } }))
      return
    }

    const apiPatch = { memo: newMemo }
    const body = subTxId
      ? buildSplitBody(txId, new Set([subTxId]), apiPatch)
      : { transaction: apiPatch }
    try {
      await apiFetch(`/budgets/${selectedBudgetId}/transactions/${txId}`, token, 'PATCH', body)
      if (subTxId) applySubsUpdate(txId, new Set([subTxId]), apiPatch)
      setBaseRows(prev => prev.map(row => {
        if (row._txId !== txId) return row
        if (subTxId !== null && row._subTxId !== subTxId) return row
        return { ...row, ...rowPatch }
      }))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '24px', display: 'flex', flexDirection: 'column', height: '100vh', boxSizing: 'border-box', overflow: 'hidden' }}>
      <div style={{ marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <form onSubmit={handleConnect} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ fontSize: '14px' }}>
            Personal Access Token:
            <input
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="ynab_..."
              style={{ marginLeft: '8px', padding: '4px 8px', fontSize: '14px', width: '320px' }}
            />
          </label>
          <button type="submit" style={{ padding: '4px 12px', fontSize: '14px' }}>Connect</button>
          <a href="https://app.ynab.com/settings/developer" target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', color: '#2980b9' }}>Get API key</a>
        </form>

        {budgets.length > 0 && (
          <select
            value={selectedBudgetId}
            onChange={handleBudgetChange}
            style={{ padding: '4px 8px', fontSize: '14px' }}
          >
            <option value="">— Budget —</option>
            {budgets.map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        )}

        {selectedBudgetId && (
          newScenarioInput !== null
            ? <form onSubmit={handleCreateScenario} style={{ display: 'flex', gap: '4px' }}>
                <input
                  autoFocus
                  value={newScenarioInput}
                  onChange={e => setNewScenarioInput(e.target.value)}
                  placeholder="Scenario name"
                  onKeyDown={e => { if (e.key === 'Escape') setNewScenarioInput(null) }}
                  style={{ padding: '4px 8px', fontSize: '14px', width: '160px' }}
                />
                <button type="submit" style={{ padding: '4px 10px', fontSize: '14px' }}>Create</button>
                <button type="button" onClick={() => setNewScenarioInput(null)} style={{ padding: '4px 10px', fontSize: '14px' }}>Cancel</button>
              </form>
            : <select
                value={activeScenario}
                onChange={handleScenarioChange}
                style={{ padding: '4px 8px', fontSize: '14px' }}
              >
                {scenarios.map(s => <option key={s} value={s}>{s}</option>)}
                <option value="__new__">＋ New scenario…</option>
              </select>
        )}

        {selectedBudgetId && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              style={{ padding: '3px 6px', fontSize: '13px' }}
            />
            –
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              style={{ padding: '3px 6px', fontSize: '13px' }}
            />
          </span>
        )}
      </div>

      {activeScenario === MAIN && selectedBudgetId && (
        <div style={{ marginBottom: '8px', padding: '6px 12px', background: '#fff3e0', border: '1px solid #f5a623', borderRadius: '4px', fontSize: '13px', color: '#7a4f00', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span>You're on the main branch</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' }}>
            Edit live data?
            <input type="checkbox" checked={editLiveData} onChange={e => setEditLiveData(e.target.checked)} style={{ cursor: 'pointer' }} />
            <span style={{ fontWeight: 600 }}>{editLiveData ? 'On' : 'Off'}</span>
          </label>
        </div>
      )}
      {loading && <p style={{ color: '#555' }}>Loading…</p>}
      {error   && <p style={{ color: 'red'  }}>{error}</p>}

      <div style={{ borderBottom: '1px solid #ddd', marginBottom: '20px', display: 'flex', alignItems: 'center' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={TAB_STYLE(activeTab === tab)}>
            {tab}
          </button>
        ))}
        {undoStack.length > 0 && (
          <button onClick={handleUndo} style={{ marginLeft: '16px', fontSize: '12px', padding: '2px 10px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4' }}>
            Undo {undoStack[undoStack.length - 1].label ? `${undoStack[undoStack.length - 1].label} ` : ''}(⌘Z)
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'Transactions' && <TransactionsTab rows={rows} catOptions={catOptions} onUpdateCategory={updateCategory} onBulkUpdateCategory={bulkUpdateCategory} onUpdateMemo={updateMemo} isMainScenario={activeScenario === MAIN} />}
        {activeTab === 'Categories'   && <CategoriesTab   catTree={catTree} rows={rows} onMoveNode={moveNode} onRenameNode={renameNode} onDeleteNode={deleteNode} />}
        {activeTab === 'Reports'      && <ReportsTab      key={`${selectedBudgetId}_${activeScenario}`} rows={rows} loading={loading} budgetId={selectedBudgetId} scenario={activeScenario} catTree={catTree} catOptions={catOptions} mergeChildren={mergeChildren} onUpdateCategory={updateCategory} onBulkUpdateCategory={bulkUpdateCategory} onUpdateMemo={updateMemo} isMainScenario={activeScenario === MAIN} onRenameNode={renameNode} onMoveNode={moveNode} onMergeNode={mergeNode} onUnmergeNode={unmergeNode} onSplitNode={splitNode} onAbsorbChildren={absorbChildren} onPushUndo={pushUndo} onRemoveUndos={removeUndos} />}
      </div>
    </div>
  )
}
