import { useState, useCallback, useEffect } from 'react'
import Papa from 'papaparse'
import TransactionsTab from './TransactionsTab'
import CategoriesTab from './CategoriesTab'
import ReportsTab from './ReportsTab'

const TABS = ['Transactions', 'Categories', 'Reports']

function parseCSVText(text) {
  const results = Papa.parse(text, { header: true, skipEmptyLines: true })
  return { rows: results.data, errors: results.errors }
}

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

export default function App() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  const [filename, setFilename] = useState(null)
  const [activeTab, setActiveTab] = useState('Transactions')
  const [selectedGroups, setSelectedGroups] = useState(null) // null = not yet initialized

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

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '24px' }}>
      <h1 style={{ marginBottom: '16px' }}>Budget Thing</h1>

      <label
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        style={{
          display: 'inline-block',
          border: '2px dashed #888',
          borderRadius: '8px',
          padding: '24px 40px',
          cursor: 'pointer',
          marginBottom: '24px',
          background: '#f9f9f9',
        }}
      >
        <input type="file" accept=".csv" onChange={handleInputChange} style={{ display: 'none' }} />
        {filename
          ? <>Loaded: <strong>{filename}</strong> &nbsp;(click or drop to replace)</>
          : <>Drop a YNAB CSV here, or <strong>click to browse</strong></>}
      </label>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      <div style={{ borderBottom: '1px solid #ddd', marginBottom: '20px' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={TAB_STYLE(activeTab === tab)}>
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Transactions' && <TransactionsTab rows={rows} />}
      {activeTab === 'Categories'   && <CategoriesTab   rows={rows} selectedGroups={selectedGroups} onSelectedGroupsChange={setSelectedGroups} />}
      {activeTab === 'Reports'      && <ReportsTab      rows={rows} selectedGroups={selectedGroups} />}
    </div>
  )
}
