import { useState, useCallback, useRef } from 'react'
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

export default function TransactionsTab({ rows, categoryGroups, onUpdateCategory, onBulkUpdateCategory }) {
  const [hideInflow,  setHideInflow]  = useState(true)
  const [colWidths,   setColWidths]   = useState(DEFAULT_WIDTHS)
  const [sort,        setSort]        = useState({ key: 'Date', dir: 'desc' })
  const [updatingIds, setUpdatingIds] = useState(new Set())
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkBusy,    setBulkBusy]    = useState(false)

  const scrollRef = useRef(null)

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

  const handleBulkCategoryChange = async (e) => {
    const newCategoryId = e.target.value
    if (!newCategoryId) return
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

  const totalWidth = CHECKBOX_WIDTH + COLUMNS.reduce((sum, { key }) => sum + colWidths[key], 0)

  return (
    <>
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
        <select
          value=""
          onChange={handleBulkCategoryChange}
          disabled={bulkBusy || selectedIds.size === 0}
          style={{ padding: '3px 6px', fontSize: '13px' }}
        >
          <option value="">— pick category —</option>
          {categoryGroups.map(group => (
            <optgroup key={group.id} label={group.name}>
              {group.categories.map(cat => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
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
        style={{ overflowX: 'auto', overflowY: 'auto', height: 'calc(100vh - 280px)', contain: 'strict' }}
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
              const row = visibleRows[virtualRow.index]
              return (
                <tr
                  key={virtualRow.key}
                  style={{ background: selectedIds.has(rowKey(row)) ? '#ddeeff' : (virtualRow.index % 2 === 0 ? '#fff' : '#f4f6f8') }}
                >
                  <td style={CHECK_TD_STYLE}>
                    <input type="checkbox" checked={selectedIds.has(rowKey(row))} onChange={() => toggleRow(row)} />
                  </td>
                  {COLUMNS.map(({ key }) => (
                    <td key={key} title={key !== 'Category' ? (row[key] ?? '') : undefined} style={TD_STYLE}>
                      {key === 'Category'
                        ? <CategorySelect
                            row={row}
                            categoryGroups={categoryGroups}
                            onUpdateCategory={handleUpdateCategory}
                            updating={updatingIds.has(rowKey(row))}
                          />
                        : (row[key] ?? '')}
                    </td>
                  ))}
                </tr>
              )
            })}
            {paddingBottom > 0 && (
              <tr><td colSpan={COLUMNS.length + 1} style={{ height: paddingBottom, padding: 0, border: 'none' }} /></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
