import { useState, useCallback, useEffect, useRef } from 'react'
import Papa from 'papaparse'

const COLUMNS = [
  { key: 'Account',                   defaultWidth: 180 },
  { key: 'Date',                      defaultWidth: 100 },
  { key: 'Payee',                     defaultWidth: 140 },
  { key: 'Category Group/Category',   defaultWidth: 220 },
  { key: 'Category Group',            defaultWidth: 180 },
  { key: 'Category',                  defaultWidth: 160 },
  { key: 'Memo',                      defaultWidth: 160 },
  { key: 'Outflow',                   defaultWidth: 90  },
  { key: 'Inflow',                    defaultWidth: 90  },
]

const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map(c => [c.key, c.defaultWidth]))

const TD_STYLE = {
  padding: '6px 12px',
  border: '1px solid #ddd',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '0',
}

function parseMoney(val) {
  if (!val) return 0
  return parseFloat(val.replace(/[$,]/g, '')) || 0
}

function parseCSVText(text) {
  const results = Papa.parse(text, { header: true, skipEmptyLines: true })
  return { rows: results.data, errors: results.errors }
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

export default function App() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  const [filename, setFilename] = useState(null)
  const [hideInflow, setHideInflow] = useState(true)
  const [colWidths, setColWidths] = useState(DEFAULT_WIDTHS)
  const [sort, setSort] = useState({ key: null, dir: 'desc' })

  useEffect(() => {
    const cached = localStorage.getItem('ynab_csv')
    const cachedName = localStorage.getItem('ynab_csv_name')
    if (cached) {
      const { rows: parsedRows, errors } = parseCSVText(cached)
      if (errors.length === 0) {
        setRows(parsedRows)
        setFilename(cachedName ?? 'cached file')
      }
    }
  }, [])

  const handleResize = useCallback((key, width) => {
    setColWidths(prev => ({ ...prev, [key]: width }))
  }, [])

  const handleFile = useCallback((file) => {
    if (!file) return
    setError(null)
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target.result
      const { rows: parsedRows, errors } = parseCSVText(text)
      if (errors.length > 0) {
        setError(`Parse error: ${errors[0].message}`)
        return
      }
      try {
        localStorage.setItem('ynab_csv', text)
        localStorage.setItem('ynab_csv_name', file.name)
      } catch {
        // localStorage full — proceed without caching
      }
      setFilename(file.name)
      setRows(parsedRows)
    }
    reader.readAsText(file)
  }, [])

  const handleInputChange = (e) => handleFile(e.target.files[0])
  const handleDrop = (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }
  const handleDragOver = (e) => e.preventDefault()

  const handleSort = useCallback((key) => {
    setSort(prev => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }))
  }, [])

  const MONEY_COLS = new Set(['Outflow', 'Inflow'])

  const filteredRows = hideInflow
    ? rows.filter((r) => parseMoney(r['Inflow']) === 0)
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

  const totalWidth = COLUMNS.reduce((sum, { key }) => sum + colWidths[key], 0)

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '24px' }}>
      <h1 style={{ marginBottom: '16px' }}>YNAB Viewer</h1>

      <label
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        style={{
          display: 'inline-block',
          border: '2px dashed #888',
          borderRadius: '8px',
          padding: '24px 40px',
          cursor: 'pointer',
          marginBottom: '16px',
          background: '#f9f9f9',
        }}
      >
        <input type="file" accept=".csv" onChange={handleInputChange} style={{ display: 'none' }} />
        {filename
          ? <>Loaded: <strong>{filename}</strong> &nbsp;(click or drop to replace)</>
          : <>Drop a YNAB CSV here, or <strong>click to browse</strong></>}
      </label>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {rows.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
            <span style={{ color: '#555' }}>{visibleRows.length} of {rows.length} transactions</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={hideInflow}
                onChange={(e) => setHideInflow(e.target.checked)}
              />
              Hide inflow rows
            </label>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed', width: totalWidth }}>
              <thead>
                <tr style={{ background: '#2c3e50', color: '#fff' }}>
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
                {visibleRows.map((row, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f4f6f8' }}>
                    {COLUMNS.map(({ key }) => (
                      <td key={key} title={row[key] ?? ''} style={TD_STYLE}>
                        {row[key] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
