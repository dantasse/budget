import { useState, useEffect, useRef } from 'react'
import TransactionsTab from './TransactionsTab'
import CategoriesTab from './CategoriesTab'
import ReportsTab from './ReportsTab'

const TABS = ['Transactions', 'Categories', 'Reports']
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

function scenarioEditsKey(budgetId, name) { return `ynab_scenario_${budgetId}_${name}` }
function scenariosListKey(budgetId)       { return `ynab_scenarios_${budgetId}` }

function loadScenarioEdits(budgetId, name) {
  try { return JSON.parse(localStorage.getItem(scenarioEditsKey(budgetId, name))) ?? {} }
  catch { return {} }
}

function saveScenarioEdits(budgetId, name, edits) {
  localStorage.setItem(scenarioEditsKey(budgetId, name), JSON.stringify(edits))
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
  const [scenarioEdits,    setScenarioEdits]    = useState({})
  const [newScenarioInput, setNewScenarioInput] = useState(null) // null = hidden, string = visible
  // txSubsById: Map<txId, Array<{id, amount, category_id, memo}>> — full subtransaction list per split tx,
  // needed to reconstruct the complete array when patching a single subtransaction's category.
  const txSubsById = useRef(new Map())
  const [loading,          setLoading]          = useState(false)
  const [error,            setError]            = useState(null)
  const [activeTab,        setActiveTab]        = useState('Transactions')
  const [selectedGroups,   setSelectedGroups]   = useState(null)

  const rows = applyEdits(baseRows, scenarioEdits)

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
    const defaultScenario = loadedScenarios.find(s => s !== MAIN) ?? MAIN
    setActiveScenario(defaultScenario)
    setScenarioEdits(loadScenarioEdits(selectedBudgetId, defaultScenario))
    Promise.all([
      apiFetch(`/budgets/${selectedBudgetId}/transactions`, token),
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
  }

  const handleScenarioChange = (e) => {
    const name = e.target.value
    if (name === '__new__') {
      setNewScenarioInput('')
      return
    }
    setActiveScenario(name)
    setScenarioEdits(selectedBudgetId ? loadScenarioEdits(selectedBudgetId, name) : {})
  }

  const handleCreateScenario = (e) => {
    e.preventDefault()
    const name = newScenarioInput.trim()
    if (!name || scenarios.includes(name)) return
    const next = [...scenarios, name]
    setScenarios(next)
    saveScenariosList(selectedBudgetId, next)
    setActiveScenario(name)
    setScenarioEdits({})
    setNewScenarioInput(null)
  }

  function resolveCategory(newCategoryId) {
    for (const group of categoryGroups) {
      const cat = group.categories.find(c => c.id === newCategoryId)
      if (cat) return { newGroup: group.name, newName: cat.name }
    }
    return { newGroup: '', newName: '' }
  }

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

  function updateEdits(updater) {
    setScenarioEdits(prev => {
      const next = updater(prev)
      saveScenarioEdits(selectedBudgetId, activeScenario, next)
      return next
    })
  }

  const renameGroup = (originalName, newName) => {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === originalName) return
    updateEdits(prev => {
      const next = { ...prev }
      for (const row of rows) {
        if ((row['Category Group'] ?? '') !== originalName) continue
        const key = `${row._txId}/${row._subTxId}`
        next[key] = { ...(prev[key] ?? {}), 'Category Group': trimmed }
      }
      return next
    })
  }

  const updateCategory = async (txId, subTxId, newCategoryId) => {
    const { newGroup, newName } = resolveCategory(newCategoryId)
    const rowPatch = { _categoryId: newCategoryId, 'Category Group': newGroup, 'Category': newName }
    const key = `${txId}/${subTxId}`

    if (activeScenario !== MAIN) {
      updateEdits(prev => ({ ...prev, [key]: { ...prev[key], ...rowPatch } }))
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
        return { ...row, ...rowPatch }
      }))
    } catch (e) {
      setError(e.message)
    }
  }

  const bulkUpdateCategory = async (rowKeys, newCategoryId) => {
    const { newGroup, newName } = resolveCategory(newCategoryId)
    const keySet = new Set(rowKeys)
    const rowPatch = { _categoryId: newCategoryId, 'Category Group': newGroup, 'Category': newName }

    if (activeScenario !== MAIN) {
      updateEdits(prev => {
        const next = { ...prev }
        for (const k of keySet) next[k] = { ...prev[k], ...rowPatch }
        return next
      })
      return
    }

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
    const rowPatch = { 'Memo': newMemo }
    const key = `${txId}/${subTxId}`

    if (activeScenario !== MAIN) {
      updateEdits(prev => ({ ...prev, [key]: { ...prev[key], ...rowPatch } }))
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
      </div>

      {activeScenario === MAIN && selectedBudgetId && (
        <div style={{ marginBottom: '8px', padding: '6px 12px', background: '#fff3e0', border: '1px solid #f5a623', borderRadius: '4px', fontSize: '13px', color: '#7a4f00' }}>
          ⚠ You are editing real data
        </div>
      )}
      {loading && <p style={{ color: '#555' }}>Loading…</p>}
      {error   && <p style={{ color: 'red'  }}>{error}</p>}

      <div style={{ borderBottom: '1px solid #ddd', marginBottom: '20px' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={TAB_STYLE(activeTab === tab)}>
            {tab}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'Transactions' && <TransactionsTab rows={rows} categoryGroups={categoryGroups} onUpdateCategory={updateCategory} onBulkUpdateCategory={bulkUpdateCategory} onUpdateMemo={updateMemo} isMainScenario={activeScenario === MAIN} />}
        {activeTab === 'Categories'   && <CategoriesTab   rows={rows} selectedGroups={selectedGroups} onSelectedGroupsChange={setSelectedGroups} />}
        {activeTab === 'Reports'      && <ReportsTab      rows={rows} selectedGroups={selectedGroups} budgetId={selectedBudgetId} categoryGroups={categoryGroups} onUpdateCategory={updateCategory} onBulkUpdateCategory={bulkUpdateCategory} onUpdateMemo={updateMemo} isMainScenario={activeScenario === MAIN} onRenameGroup={renameGroup} />}
      </div>
    </div>
  )
}
