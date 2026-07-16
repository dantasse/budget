import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import TransactionsTab from './TransactionsTab'
import ReportsTab from './ReportsTab'

const TABS = ['Transactions', 'Reports']
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
        'Category Group': cat.group,
        'Category':       cat.name,
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
function catModelKey(budgetId, name)   { return `ynab_catmodel_${budgetId}_${name}` }

function loadMemoEdits(budgetId, name) {
  try { return JSON.parse(localStorage.getItem(memoEditsKey(budgetId, name))) ?? {} }
  catch { return {} }
}

function saveMemoEdits(budgetId, name, edits) {
  localStorage.setItem(memoEditsKey(budgetId, name), JSON.stringify(edits))
}

// catModel: the scenario's category mapping (see DATA_MODEL.md).
// cats:   { [catId]: { name, group, splitFrom? } } — overrides for ynab ids, definitions for local ids
// routes: { [ynabCatId]: catId } — that category's transactions display as catId
// txCats: { [txKey]: catId } — per-transaction exceptions
// groups: { [ynabGroupId]: newName } — group renames
// Invariant: routes/txCats values always point at final, live catIds (ops flatten on write).
const EMPTY_CAT_MODEL = { cats: {}, routes: {}, txCats: {}, groups: {} }

function loadCatModel(budgetId, name) {
  try {
    const m = JSON.parse(localStorage.getItem(catModelKey(budgetId, name)))
    return m ? { ...EMPTY_CAT_MODEL, ...m } : EMPTY_CAT_MODEL
  } catch { return EMPTY_CAT_MODEL }
}

function saveCatModel(budgetId, name, model) {
  localStorage.setItem(catModelKey(budgetId, name), JSON.stringify(model))
}

function localCatId(groupName, name) { return `local:${groupName}:${name}` }
function isLocalCatId(id) { return id.startsWith('local:') }

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
  const [loading,          setLoading]          = useState(false)
  const [error,            setError]            = useState(null)
  // URL path is /{scenario}/{tab}; consumed once on initial budget load, then null.
  const urlPathRef = useRef(parsePath())
  const [activeTab,        setActiveTab]        = useState(() =>
    TABS.includes(urlPathRef.current.tab) ? urlPathRef.current.tab : 'Transactions')
  const [startDate,        setStartDate]        = useState(defaultStartDate)
  const [endDate,          setEndDate]          = useState(() => isoDate(new Date()))

  // ynabCatInfo: catId → { name, group, groupId } from the YNAB structure
  const ynabCatInfo = useMemo(() => {
    const map = new Map()
    for (const g of categoryGroups) {
      for (const c of g.categories) map.set(c.id, { name: c.name, group: g.name, groupId: g.id })
    }
    return map
  }, [categoryGroups])

  // effective definition of a category under a model: override, else YNAB (with group rename applied)
  function catDef(model, catId) {
    const override = model.cats[catId]
    if (override) return override
    const info = ynabCatInfo.get(catId)
    if (!info) return null
    return { name: info.name, group: model.groups[info.groupId] ?? info.group }
  }

  // allRows: every transaction with memo edits applied and its category resolved
  // through the scenario's catModel; rows: allRows narrowed to the date pickers.
  // Rows leave here final — tabs never re-resolve categories.
  const allRows = useMemo(() => {
    const withMemos = applyEdits(baseRows, memoEdits)
    const { cats, routes, txCats } = catModel
    if (Object.keys(cats).length === 0 && Object.keys(routes).length === 0 &&
        Object.keys(txCats).length === 0 && Object.keys(catModel.groups).length === 0) {
      return withMemos
    }
    return withMemos.map(row => {
      const key = `${row._txId}/${row._subTxId}`
      const catId = txCats[key] ?? routes[row._categoryId] ?? row._categoryId
      const def = catDef(catModel, catId)
      // unknown id (e.g., a hidden YNAB category): keep the row's stamped names
      if (!def) return row
      if (catId === row._categoryId && def.name === row['Category'] && def.group === row['Category Group']) return row
      // _ynabCategoryId preserves the pre-resolution id (used for merge-child totals)
      return { ...row, _ynabCategoryId: row._categoryId, _categoryId: catId, 'Category': def.name, 'Category Group': def.group }
    })
  }, [baseRows, memoEdits, catModel, ynabCatInfo])
  // an empty (cleared) date input means that bound is unlimited
  const rows = allRows.filter(r =>
    (!startDate || r['Date'] >= startDate) && (!endDate || r['Date'] <= endDate))

  useEffect(() => {
    if (!token) return
    setLoading(true)
    setError(null)
    apiFetch('/budgets', token)
      .then(({ data }) => setBudgets(data.budgets))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [token])

  useEffect(() => {
    if (!token || !selectedBudgetId) return
    setLoading(true)
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
        setCategoryGroups(
          catData.data.category_groups
            .filter(g => !g.deleted && !g.hidden)
            .map(g => ({
              id: g.id,
              name: g.name,
              categories: g.categories.filter(c => !c.deleted && !c.hidden).map(c => ({ id: c.id, name: c.name })),
            }))
            .filter(g => g.categories.length > 0)
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
      .finally(() => setLoading(false))
  }, [token, selectedBudgetId])

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

  const mergedCategoryGroups = useMemo(() => {
    // the dropdowns' category list: YNAB categories that aren't routed away
    // (merged/split sources have no identity of their own anymore), with
    // overrides and group renames applied, plus scenario-local categories
    const entries = []
    for (const g of categoryGroups) {
      for (const c of g.categories) {
        if (catModel.routes[c.id]) continue
        const def = catDef(catModel, c.id)
        entries.push({ id: c.id, name: def.name, group: def.group })
      }
    }
    for (const [id, def] of Object.entries(catModel.cats)) {
      if (isLocalCatId(id)) entries.push({ id, name: def.name, group: def.group })
    }
    const ynabGroupIds = new Map(categoryGroups.map(g => [catModel.groups[g.id] ?? g.name, g.id]))
    const byGroup = new Map()
    for (const { id, name, group } of entries) {
      if (!byGroup.has(group)) {
        byGroup.set(group, { id: ynabGroupIds.get(group) ?? `local-group:${group}`, name: group, categories: [] })
      }
      byGroup.get(group).categories.push({ id, name })
    }
    return [...byGroup.values()]
  }, [categoryGroups, catModel])

  // mergeChildren: parent display name → [{ id, name }] of YNAB categories merged into it
  // (split routes are excluded — their targets carry splitFrom pointing back at the source)
  const mergeChildren = useMemo(() => {
    const byParent = new Map()
    for (const [from, into] of Object.entries(catModel.routes)) {
      if (catModel.cats[into]?.splitFrom === from) continue
      const parentName = catDef(catModel, into)?.name ?? into
      if (!byParent.has(parentName)) byParent.set(parentName, [])
      byParent.get(parentName).push({ id: from, name: ynabCatInfo.get(from)?.name ?? from })
    }
    return byParent
  }, [catModel, ynabCatInfo])

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

  const renameCategory = (catId, newName) => {
    const trimmed = newName.trim()
    if (!trimmed) return
    applyCatOp(undefined, model => {
      const def = catDef(model, catId)
      if (!def || def.name === trimmed) return model
      return { ...model, cats: { ...model.cats, [catId]: { ...def, name: trimmed } } }
    })
  }

  const moveCategory = (catId, newGroupName) => {
    applyCatOp('group move', model => {
      const def = catDef(model, catId)
      if (!def || def.group === newGroupName) return model
      return { ...model, cats: { ...model.cats, [catId]: { ...def, group: newGroupName } } }
    })
  }

  const renameGroup = (originalName, newName) => {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === originalName) return
    applyCatOp(undefined, model => {
      const groups = { ...model.groups }
      for (const g of categoryGroups) {
        if ((model.groups[g.id] ?? g.name) === originalName) groups[g.id] = trimmed
      }
      const cats = { ...model.cats }
      for (const [id, def] of Object.entries(model.cats)) {
        if (def.group === originalName) cats[id] = { ...def, group: trimmed }
      }
      return { ...model, groups, cats }
    })
  }

  const mergeCategory = (fromId, intoId) => {
    if (fromId === intoId) return
    applyCatOp('merge', model => {
      const routes = { ...model.routes }
      const txCats = { ...model.txCats }
      // flatten: anything pointing at fromId now points at intoId
      for (const [k, v] of Object.entries(routes)) if (v === fromId) routes[k] = intoId
      for (const [k, v] of Object.entries(txCats)) if (v === fromId) txCats[k] = intoId
      const cats = { ...model.cats }
      delete cats[fromId]
      if (!isLocalCatId(fromId)) routes[fromId] = intoId
      return { ...model, routes, txCats, cats }
    })
  }

  const unmergeCategory = (fromId) => {
    applyCatOp(undefined, model => {
      if (!model.routes[fromId]) return model
      const routes = { ...model.routes }
      delete routes[fromId]
      return { ...model, routes }
    })
  }

  const applySplit = (sourceId, validParts, assignments) => {
    // assignments: { [txKey]: partIdx }; unassigned rows (and future
    // transactions) follow the route to part 0
    applyCatOp('split', model => {
      const def = catDef(model, sourceId)
      if (!def) return model
      const group = def.group
      const origin = model.cats[sourceId]?.splitFrom ?? sourceId
      const originName = model.cats[sourceId]?.splitFromName ?? ynabCatInfo.get(origin)?.name ?? def.name
      const partIds = validParts.map(p => localCatId(group, p))
      const cats = { ...model.cats }
      validParts.forEach((name, i) => { cats[partIds[i]] = { name, group, splitFrom: origin, splitFromName: originName } })
      const routes = { ...model.routes }
      const txCats = { ...model.txCats }
      // flatten: anything pointing at the source now points at part 0
      for (const [k, v] of Object.entries(routes)) if (v === sourceId) routes[k] = partIds[0]
      for (const [k, v] of Object.entries(txCats)) if (v === sourceId) txCats[k] = partIds[0]
      if (isLocalCatId(sourceId)) delete cats[sourceId]
      else routes[sourceId] = partIds[0]
      for (const [key, partIdx] of Object.entries(assignments)) {
        if (partIdx > 0 && partIds[partIdx]) txCats[key] = partIds[partIdx]
      }
      return { ...model, cats, routes, txCats }
    })
  }

  const removeSplit = (origin) => {
    applyCatOp(undefined, model => {
      const partSet = new Set(
        Object.entries(model.cats).filter(([, d]) => d.splitFrom === origin).map(([id]) => id))
      if (partSet.size === 0) return model
      const cats = { ...model.cats }
      for (const id of partSet) delete cats[id]
      const routes = {}
      for (const [k, v] of Object.entries(model.routes)) {
        if (partSet.has(k)) continue
        const target = partSet.has(v) ? origin : v
        if (k !== target) routes[k] = target
      }
      const txCats = {}
      for (const [k, v] of Object.entries(model.txCats)) {
        if (!partSet.has(v)) txCats[k] = v
      }
      return { ...model, cats, routes, txCats }
    })
  }

  const recategorizeTx = (keys, catId) => {
    applyCatOp(undefined, model => {
      const txCats = { ...model.txCats }
      for (const k of keys) txCats[k] = catId
      return { ...model, txCats }
    })
  }

  const updateCategory = async (txId, subTxId, newCategoryId) => {
    if (activeScenario === MAIN && !editLiveData) return
    const key = `${txId}/${subTxId}`

    if (activeScenario !== MAIN) {
      recategorizeTx([key], newCategoryId)
      return
    }

    const info = ynabCatInfo.get(newCategoryId)
    const rowPatch = { _categoryId: newCategoryId, 'Category Group': info?.group ?? '', 'Category': info?.name ?? '' }
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
        return { ...row, ...rowPatch }
      }))
    } catch (e) {
      setError(e.message)
    }
  }

  const bulkUpdateCategory = async (rowKeys, newCategoryId) => {
    if (activeScenario === MAIN && !editLiveData) return

    if (activeScenario !== MAIN) {
      recategorizeTx(rowKeys, newCategoryId)
      return
    }

    const keySet = new Set(rowKeys)
    const info = ynabCatInfo.get(newCategoryId)
    const rowPatch = { _categoryId: newCategoryId, 'Category Group': info?.group ?? '', 'Category': info?.name ?? '' }
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
        return { ...row, ...rowPatch }
      }))
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
        {activeTab === 'Transactions' && <TransactionsTab rows={rows} categoryGroups={mergedCategoryGroups} onUpdateCategory={updateCategory} onBulkUpdateCategory={bulkUpdateCategory} onUpdateMemo={updateMemo} isMainScenario={activeScenario === MAIN} />}
        {activeTab === 'Reports'      && <ReportsTab      key={`${selectedBudgetId}_${activeScenario}`} rows={rows} budgetId={selectedBudgetId} scenario={activeScenario} categoryGroups={mergedCategoryGroups} catModel={catModel} mergeChildren={mergeChildren} onUpdateCategory={updateCategory} onBulkUpdateCategory={bulkUpdateCategory} onUpdateMemo={updateMemo} isMainScenario={activeScenario === MAIN} onRenameGroup={renameGroup} onRenameCategory={renameCategory} onMoveCategory={moveCategory} onMergeCategory={mergeCategory} onUnmergeCategory={unmergeCategory} onApplySplit={applySplit} onRemoveSplit={removeSplit} onPushUndo={pushUndo} onRemoveUndos={removeUndos} />}
      </div>
    </div>
  )
}
