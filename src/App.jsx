import { useState, useEffect, useRef } from 'react'
import TransactionsTab from './TransactionsTab'
import CategoriesTab from './CategoriesTab'
import ReportsTab from './ReportsTab'

const TABS = ['Transactions', 'Categories', 'Reports']
const API  = 'https://api.ynab.com/v1'

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

export default function App() {
  const [token,            setToken]            = useState(() => localStorage.getItem('ynab_token') ?? '')
  const [tokenInput,       setTokenInput]       = useState(() => localStorage.getItem('ynab_token') ?? '')
  const [budgets,          setBudgets]          = useState([])
  const [selectedBudgetId, setSelectedBudgetId] = useState(() => localStorage.getItem('ynab_budget_id') ?? '')
  const [categoryGroups,   setCategoryGroups]   = useState([])
  const [rows,             setRows]             = useState([])
  // txSubsById: Map<txId, Array<{id, amount, category_id}>> — full subtransaction list per split tx,
  // needed to reconstruct the complete array when patching a single subtransaction's category.
  const txSubsById = useRef(new Map())
  const [loading,          setLoading]          = useState(false)
  const [error,            setError]            = useState(null)
  const [activeTab,        setActiveTab]        = useState('Transactions')
  const [selectedGroups,   setSelectedGroups]   = useState(null)

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
        setRows(toRows(txData.data.transactions, catMap))
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
    setRows([])
    setBudgets([])
  }

  const handleBudgetChange = (e) => {
    const id = e.target.value
    localStorage.setItem('ynab_budget_id', id)
    setSelectedBudgetId(id)
    setRows([])
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

  const updateCategory = async (txId, subTxId, newCategoryId) => {
    const { newGroup, newName } = resolveCategory(newCategoryId)
    const patch = { category_id: newCategoryId }
    const body = subTxId
      ? buildSplitBody(txId, new Set([subTxId]), patch)
      : { transaction: patch }
    try {
      await apiFetch(`/budgets/${selectedBudgetId}/transactions/${txId}`, token, 'PATCH', body)
      if (subTxId) applySubsUpdate(txId, new Set([subTxId]), patch)
      setRows(prev => prev.map(row => {
        if (row._txId !== txId) return row
        if (subTxId !== null && row._subTxId !== subTxId) return row
        return { ...row, _categoryId: newCategoryId, 'Category Group': newGroup, 'Category': newName }
      }))
    } catch (e) {
      setError(e.message)
    }
  }

  const bulkUpdateCategory = async (rowKeys, newCategoryId) => {
    const { newGroup, newName } = resolveCategory(newCategoryId)
    const keySet = new Set(rowKeys)
    const selected = rows.filter(r => keySet.has(`${r._txId}/${r._subTxId}`))
    const nonSplit = selected.filter(r => r._subTxId === null)
    const split    = selected.filter(r => r._subTxId !== null)

    // Group split rows by txId so we send one PATCH per parent transaction
    const splitByTx = new Map()
    for (const r of split) {
      if (!splitByTx.has(r._txId)) splitByTx.set(r._txId, new Set())
      splitByTx.get(r._txId).add(r._subTxId)
    }

    try {
      await Promise.all([
        nonSplit.length > 0 && apiFetch(`/budgets/${selectedBudgetId}/transactions`, token, 'PATCH', {
          transactions: nonSplit.map(r => ({ id: r._txId, category_id: newCategoryId })),
        }),
        ...[...splitByTx.entries()].map(([txId, subIds]) =>
          apiFetch(`/budgets/${selectedBudgetId}/transactions/${txId}`, token, 'PATCH',
            buildSplitBody(txId, subIds, { category_id: newCategoryId }))
        ),
      ].filter(Boolean))
      for (const [txId, subIds] of splitByTx) applySubsUpdate(txId, subIds, { category_id: newCategoryId })
      setRows(prev => prev.map(row => {
        if (!keySet.has(`${row._txId}/${row._subTxId}`)) return row
        return { ...row, _categoryId: newCategoryId, 'Category Group': newGroup, 'Category': newName }
      }))
    } catch (e) {
      setError(e.message)
    }
  }

  const updateMemo = async (txId, subTxId, newMemo) => {
    const patch = { memo: newMemo }
    const body = subTxId
      ? buildSplitBody(txId, new Set([subTxId]), patch)
      : { transaction: patch }
    try {
      await apiFetch(`/budgets/${selectedBudgetId}/transactions/${txId}`, token, 'PATCH', body)
      if (subTxId) applySubsUpdate(txId, new Set([subTxId]), patch)
      setRows(prev => prev.map(row => {
        if (row._txId !== txId) return row
        if (subTxId !== null && row._subTxId !== subTxId) return row
        return { ...row, 'Memo': newMemo }
      }))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '24px' }}>
      <h1 style={{ marginBottom: '16px' }}>Budget Thing</h1>

      <form onSubmit={handleConnect} style={{ marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
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
      </form>

      {loading && <p style={{ color: '#555' }}>Loading…</p>}
      {error   && <p style={{ color: 'red'  }}>{error}</p>}

      <div style={{ borderBottom: '1px solid #ddd', marginBottom: '20px' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={TAB_STYLE(activeTab === tab)}>
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Transactions' && <TransactionsTab rows={rows} categoryGroups={categoryGroups} onUpdateCategory={updateCategory} onBulkUpdateCategory={bulkUpdateCategory} onUpdateMemo={updateMemo} />}
      {activeTab === 'Categories'   && <CategoriesTab   rows={rows} selectedGroups={selectedGroups} onSelectedGroupsChange={setSelectedGroups} />}
      {activeTab === 'Reports'      && <ReportsTab      rows={rows} selectedGroups={selectedGroups} />}
    </div>
  )
}
