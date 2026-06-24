import { useState, useCallback, useRef, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'

const COLUMNS = [
  { key: 'Account',        defaultWidth: 180 },
  { key: 'Date',           defaultWidth: 100 },
  { key: 'Payee',          defaultWidth: 140 },
  { key: 'Category Group', defaultWidth: 180 },
  { key: 'Category',       defaultWidth: 200 },
  { key: 'Memo',           defaultWidth: 160 },
  { key: 'Outflow',        defaultWidth: 90  },
  { key: 'Inflow',         defaultWidth: 90  },
]

const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map(c => [c.key, c.defaultWidth]))
const CHECKBOX_WIDTH = 36
const ROW_HEIGHT     = 33
const MONEY_COLS     = new Set(['Outflow', 'Inflow'])

const TD_STYLE = {
  padding: '6px 12px',
  border: '1px solid #ddd',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '0',
}

const CHECK_TD_STYLE = {
  padding: '0',
  border: '1px solid #ddd',
  width: CHECKBOX_WIDTH,
  minWidth: CHECKBOX_WIDTH,
  maxWidth: CHECKBOX_WIDTH,
  textAlign: 'center',
}

const rowKey = r => `${r._txId}/${r._subTxId}`

function parseMoney(val) {
  if (!val) return 0
  return parseFloat(val.replace(/[$,]/g, '')) || 0
}

function CategoryCombobox({ categoryGroups, onSelect, disabled, inputRef }) {
  const [value,            setValue]            = useState('')
  const [open,             setOpen]             = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const containerRef = useRef(null)
  const listRef      = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = categoryGroups
    .map(g => ({ ...g, categories: g.categories.filter(c => c.name.toLowerCase().includes(value.toLowerCase())) }))
    .filter(g => g.categories.length > 0)

  const flatCats = filtered.flatMap(g => g.categories)

  useEffect(() => {
    if (highlightedIndex < 0 || !listRef.current) return
    listRef.current.querySelector(`[data-idx="${highlightedIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  const handleSelect = (cat) => {
    onSelect(cat.id)
    setValue('')
    setOpen(false)
    setHighlightedIndex(-1)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlightedIndex(prev => Math.min(prev + 1, flatCats.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex(prev => Math.max(prev - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = highlightedIndex >= 0 ? flatCats[highlightedIndex] : flatCats.length === 1 ? flatCats[0] : null
      if (target) handleSelect(target)
    } else if (e.key === 'Escape') {
      if (!open && value === '') {
        e.currentTarget.blur()
      } else {
        setOpen(false)
        setHighlightedIndex(-1)
      }
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      <input
        type="text"
        value={value}
        onChange={e => { setValue(e.target.value); setOpen(true); setHighlightedIndex(-1) }}
        onFocus={() => setOpen(true)}
        ref={inputRef}
        onKeyDown={handleKeyDown}
        placeholder="type to filter…"
        disabled={disabled}
        style={{ padding: '3px 6px', fontSize: '13px', width: '200px' }}
      />
      {open && filtered.length > 0 && (
        <div ref={listRef} style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100,
          background: '#fff', border: '1px solid #ccc', borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', maxHeight: '300px',
          overflowY: 'auto', minWidth: '220px',
        }}>
          {filtered.map(group => (
            <div key={group.id}>
              <div style={{ padding: '4px 10px', fontSize: '11px', color: '#999', fontWeight: 600, textTransform: 'uppercase', background: '#f8f8f8' }}>
                {group.name}
              </div>
              {group.categories.map(cat => {
                const idx = flatCats.indexOf(cat)
                return (
                  <div
                    key={cat.id}
                    data-idx={idx}
                    onMouseDown={() => handleSelect(cat)}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    style={{
                      padding: '6px 14px', cursor: 'pointer', fontSize: '13px',
                      background: highlightedIndex === idx ? '#f0f4ff' : '',
                    }}
                  >
                    {cat.name}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CategorySelect({ row, categoryGroups, onUpdateCategory, updating }) {
  const handleChange = (e) => {
    const newId = e.target.value
    if (newId !== row._categoryId) onUpdateCategory(row._txId, row._subTxId, newId)
  }

  return (
    <select
      value={row._categoryId ?? ''}
      onChange={handleChange}
      disabled={updating}
      style={{
        width: '100%',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: '13px',
        fontFamily: 'inherit',
        padding: 0,
        opacity: updating ? 0.5 : 1,
      }}
    >
      {categoryGroups.map(group => (
        <optgroup key={group.id} label={group.name}>
          {group.categories.map(cat => (
            <option key={cat.id} value={cat.id}>{cat.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function ResizableHeader({ colKey, width, onResize, onSort, sortDir, children }) {
  const startX = useRef(0)
  const startWidth = useRef(0)
  const didDrag = useRef(false)

  const onMouseDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    didDrag.current = false
    startX.current = e.clientX
    startWidth.current = width

    const onMouseMove = (e) => {
      didDrag.current = true
      const delta = e.clientX - startX.current
      onResize(colKey, Math.max(40, startWidth.current + delta))
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const handleClick = () => {
    if (!didDrag.current) onSort(colKey)
    didDrag.current = false
  }

  return (
    <th
      onClick={handleClick}
      style={{
        position: 'relative',
        width,
        minWidth: width,
        maxWidth: width,
        padding: '8px 12px',
        textAlign: 'left',
        border: '1px solid #444',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        cursor: 'pointer',
      }}
    >
      {children}
      {sortDir && <span style={{ marginLeft: '4px', opacity: 0.8 }}>{sortDir === 'desc' ? '▼' : '▲'}</span>}
      <div
        onMouseDown={onMouseDown}
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: '5px',
          cursor: 'col-resize',
        }}
      />
    </th>
  )
}

export default function TransactionsTab({ rows, categoryGroups, onUpdateCategory, onBulkUpdateCategory, onUpdateMemo, isMainScenario }) {
  const [hideInflow,       setHideInflow]       = useState(true)
  const [colWidths,        setColWidths]        = useState(DEFAULT_WIDTHS)
  const [sort,             setSort]             = useState({ key: 'Date', dir: 'desc' })
  const [updatingIds,      setUpdatingIds]      = useState(new Set())
  const [selectedIds,      setSelectedIds]      = useState(new Set())
  const [bulkBusy,         setBulkBusy]         = useState(false)
  const [focusedRowIndex,  setFocusedRowIndex]  = useState(-1)
  const [editingMemo,      setEditingMemo]      = useState(null) // { key, txId, subTxId, value }

  const scrollRef        = useRef(null)
  const comboboxInputRef = useRef(null)
  const stateRef         = useRef({})
  const virtualizerRef   = useRef(null)
  const cancelMemoRef    = useRef(false)

  const handleResize = useCallback((key, width) => {
    setColWidths(prev => ({ ...prev, [key]: width }))
  }, [])

  const handleSort = useCallback((key) => {
    setSort(prev => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }))
  }, [])

  const handleUpdateCategory = useCallback(async (txId, subTxId, newCategoryId) => {
    const key = `${txId}/${subTxId}`
    setUpdatingIds(prev => new Set([...prev, key]))
    await onUpdateCategory(txId, subTxId, newCategoryId)
    setUpdatingIds(prev => { const next = new Set(prev); next.delete(key); return next })
  }, [onUpdateCategory])

  const handleBulkCategorySelect = async (newCategoryId) => {
    const keys = [...selectedIds]
    setBulkBusy(true)
    await onBulkUpdateCategory(keys, newCategoryId)
    setBulkBusy(false)
    setSelectedIds(new Set())
  }

  const filteredRows = hideInflow
    ? rows.filter(r => parseMoney(r['Inflow']) === 0)
    : rows

  const visibleRows = sort.key
    ? [...filteredRows].sort((a, b) => {
        const av = a[sort.key] ?? ''
        const bv = b[sort.key] ?? ''
        const cmp = MONEY_COLS.has(sort.key)
          ? parseMoney(av) - parseMoney(bv)
          : av.localeCompare(bv)
        return sort.dir === 'desc' ? -cmp : cmp
      })
    : filteredRows

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  // Keep refs current every render so the stable global handler can read them
  stateRef.current      = { focusedRowIndex, visibleRows, selectedIds }
  virtualizerRef.current = virtualizer

  useEffect(() => {
    const handler = (e) => {
      const tag = document.activeElement?.tagName
      const inInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'

      if (e.key.toLowerCase() === 'k' && !e.ctrlKey && !e.metaKey && !inInput) {
        e.preventDefault()
        const { focusedRowIndex, visibleRows, selectedIds } = stateRef.current
        if (selectedIds.size === 0 && focusedRowIndex >= 0 && focusedRowIndex < visibleRows.length) {
          const key = rowKey(visibleRows[focusedRowIndex])
          flushSync(() => setSelectedIds(new Set([key])))
        }
        comboboxInputRef.current?.focus()
        return
      }

      if (inInput) return

      const { focusedRowIndex, visibleRows } = stateRef.current
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.min(focusedRowIndex + 1, visibleRows.length - 1)
        setFocusedRowIndex(next)
        virtualizerRef.current?.scrollToIndex(next, { align: 'auto' })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const next = Math.max(focusedRowIndex - 1, 0)
        setFocusedRowIndex(next)
        virtualizerRef.current?.scrollToIndex(next, { align: 'auto' })
      } else if (e.key === ' ' && focusedRowIndex >= 0 && focusedRowIndex < visibleRows.length) {
        e.preventDefault()
        const row = visibleRows[focusedRowIndex]
        const key = rowKey(row)
        setSelectedIds(prev => {
          const next = new Set(prev)
          next.has(key) ? next.delete(key) : next.add(key)
          return next
        })
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const virtualItems  = virtualizer.getVirtualItems()
  const paddingTop    = virtualItems.length > 0 ? virtualItems[0].start : 0
  const paddingBottom = virtualItems.length > 0
    ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
    : 0

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every(r => selectedIds.has(rowKey(r)))

  const toggleSelectAll = () => {
    setSelectedIds(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        visibleRows.forEach(r => next.delete(rowKey(r)))
        return next
      }
      const next = new Set(prev)
      visibleRows.forEach(r => next.add(rowKey(r)))
      return next
    })
  }

  const toggleRow = (row) => {
    const key = rowKey(row)
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const handleMemoSave = async () => {
    if (cancelMemoRef.current) { cancelMemoRef.current = false; return }
    if (!editingMemo) return
    const original = rows.find(r => r._txId === editingMemo.txId && r._subTxId === editingMemo.subTxId)
    if (editingMemo.value !== (original?.['Memo'] ?? ''))
      await onUpdateMemo(editingMemo.txId, editingMemo.subTxId, editingMemo.value)
    setEditingMemo(null)
  }

  const handleRowClick = (row, index) => {
    toggleRow(row)
    setFocusedRowIndex(index)
  }

  const totalWidth = CHECKBOX_WIDTH + COLUMNS.reduce((sum, { key }) => sum + colWidths[key], 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {isMainScenario && (
        <div style={{ marginBottom: '8px', padding: '6px 12px', background: '#fff3e0', border: '1px solid #f5a623', borderRadius: '4px', fontSize: '13px', color: '#7a4f00' }}>
          ⚠ You are editing real data
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={hideInflow}
            onChange={(e) => setHideInflow(e.target.checked)}
          />
          Hide inflow rows
        </label>
        <span style={{ color: '#aaa' }}>|</span>
        {selectedIds.size > 0 && (
          <span style={{ color: '#2c3e50', fontWeight: 600, fontSize: '13px' }}>{selectedIds.size} selected</span>
        )}
        <span style={{ color: '#555', fontSize: '13px' }}>Reassign to:</span>
        <CategoryCombobox
          categoryGroups={categoryGroups}
          onSelect={handleBulkCategorySelect}
          disabled={bulkBusy || selectedIds.size === 0}
          inputRef={comboboxInputRef}
        />
        {bulkBusy && <span style={{ color: '#555', fontSize: '13px' }}>Saving…</span>}
        {selectedIds.size > 0 && (
          <button
            onClick={() => setSelectedIds(new Set())}
            style={{ fontSize: '12px', padding: '2px 8px', cursor: 'pointer' }}
          >
            Clear selection
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, minHeight: 0, contain: 'strict', background: isMainScenario ? '#fff8f0' : undefined }}
      >
        <table style={{ borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed', width: totalWidth }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr style={{ background: '#2c3e50', color: '#fff' }}>
              <th style={{ width: CHECKBOX_WIDTH, minWidth: CHECKBOX_WIDTH, maxWidth: CHECKBOX_WIDTH, border: '1px solid #444', textAlign: 'center', padding: 0 }}>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
              </th>
              {COLUMNS.map(({ key }) => (
                <ResizableHeader
                  key={key} colKey={key} width={colWidths[key]}
                  onResize={handleResize} onSort={handleSort}
                  sortDir={sort.key === key ? sort.dir : null}
                >
                  {key}
                </ResizableHeader>
              ))}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr><td colSpan={COLUMNS.length + 1} style={{ height: paddingTop, padding: 0, border: 'none' }} /></tr>
            )}
            {virtualItems.map(virtualRow => {
              const row     = visibleRows[virtualRow.index]
              const isFocused  = focusedRowIndex === virtualRow.index
              const isSelected = selectedIds.has(rowKey(row))
              return (
                <tr
                  key={virtualRow.key}
                  onClick={() => handleRowClick(row, virtualRow.index)}
                  style={{
                    cursor: 'pointer',
                    background: isSelected ? '#ddeeff' : isFocused ? '#f0f0f0' : (virtualRow.index % 2 === 0 ? '#fff' : '#f4f6f8'),
                    outline: isFocused ? '2px solid #aac4e8' : 'none',
                    outlineOffset: '-2px',
                  }}
                >
                  <td style={CHECK_TD_STYLE} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={isSelected} onChange={() => toggleRow(row)} />
                  </td>
                  {COLUMNS.map(({ key }) => {
                    const isEditableMemo = key === 'Memo' && editingMemo?.key === rowKey(row)
                    return (
                      <td
                        key={key}
                        title={key !== 'Category' && !isEditableMemo ? (row[key] ?? '') : undefined}
                        onClick={
                          key === 'Category' ? e => e.stopPropagation()
                          : key === 'Memo' && !isEditableMemo ? e => { e.stopPropagation(); setEditingMemo({ key: rowKey(row), txId: row._txId, subTxId: row._subTxId, value: row['Memo'] ?? '' }) }
                          : key === 'Memo' ? e => e.stopPropagation()
                          : undefined
                        }
                        style={{ ...TD_STYLE, cursor: key === 'Memo' && !isEditableMemo ? 'text' : undefined }}
                      >
                        {key === 'Category'
                          ? <CategorySelect
                              row={row}
                              categoryGroups={categoryGroups}
                              onUpdateCategory={handleUpdateCategory}
                              updating={updatingIds.has(rowKey(row))}
                            />
                          : key === 'Memo' && isEditableMemo
                          ? <input
                              autoFocus
                              value={editingMemo.value}
                              onChange={e => setEditingMemo(m => ({ ...m, value: e.target.value }))}
                              onBlur={handleMemoSave}
                              onKeyDown={e => {
                                if (e.key === 'Enter')  { e.preventDefault(); handleMemoSave() }
                                if (e.key === 'Escape') { e.preventDefault(); cancelMemoRef.current = true; setEditingMemo(null) }
                                e.stopPropagation()
                              }}
                              style={{ width: '100%', boxSizing: 'border-box', border: 'none', outline: '1px solid #aac4e8', background: 'transparent', fontSize: '13px', fontFamily: 'inherit', padding: 0 }}
                            />
                          : (row[key] ?? '')}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {paddingBottom > 0 && (
              <tr><td colSpan={COLUMNS.length + 1} style={{ height: paddingBottom, padding: 0, border: 'none' }} /></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
