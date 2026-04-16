import { useMemo } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'

function parseMoney(val) {
  if (!val) return 0
  return parseFloat(val.replace(/[$,]/g, '')) || 0
}

const COLORS = [
  '#2c3e50', '#2980b9', '#27ae60', '#8e44ad', '#e67e22',
  '#c0392b', '#16a085', '#d35400', '#7f8c8d', '#f39c12',
  '#1abc9c', '#e74c3c', '#3498db', '#9b59b6', '#2ecc71',
]

const dollarFormatter = (value) =>
  '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const { name, value } = payload[0]
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

function isRowSelected(row, selectedGroups) {
  if (!selectedGroups) return true
  const group = row['Category Group']
  const cat = row['Category']
  if (selectedGroups.has(`group:${group}`)) return true
  if (cat && selectedGroups.has(`cat:${group}:${cat}`)) return true
  return false
}

export default function ReportsTab({ rows, selectedGroups }) {
  const data = useMemo(() => {
    const totals = new Map()
    for (const row of rows) {
      if (!isRowSelected(row, selectedGroups)) continue
      const group = row['Category Group']
      const cat   = row['Category']
      if (!group) continue
      const outflow = parseMoney(row['Outflow'])
      if (outflow === 0) continue
      // Use individual category name if drilled in, otherwise group name
      const label = selectedGroups?.has(`group:${group}`) ? group : (cat || group)
      totals.set(label, (totals.get(label) ?? 0) + outflow)
    }
    return [...totals.entries()]
      .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value)
  }, [rows, selectedGroups])

  if (rows.length === 0) return (
    <div style={{ color: '#555', padding: '24px 0' }}>No data loaded.</div>
  )

  const total = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <div>
      <div style={{ marginBottom: '20px', fontSize: '14px', color: '#555' }}>
        Total spending: <strong style={{ color: '#2c3e50' }}>{dollarFormatter(total)}</strong>
        {' '}across <strong>{data.length}</strong> categories
      </div>

      <ResponsiveContainer width="100%" height={420}>
        <BarChart data={data} margin={{ top: 8, right: 24, left: 16, bottom: 120 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="name"
            angle={-40}
            textAnchor="end"
            interval={0}
            tick={{ fontSize: 12 }}
          />
          <YAxis tickFormatter={dollarFormatter} tick={{ fontSize: 12 }} width={80} />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="value" name="Spending" radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <table style={{ fontSize: '13px', borderCollapse: 'collapse', marginTop: '24px', width: '100%', maxWidth: '500px' }}>
        <thead>
          <tr style={{ background: '#2c3e50', color: '#fff' }}>
            <th style={{ padding: '8px 12px', textAlign: 'left' }}>Category</th>
            <th style={{ padding: '8px 12px', textAlign: 'right' }}>Spending</th>
            <th style={{ padding: '8px 12px', textAlign: 'right' }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {data.map(({ name, value }, i) => (
            <tr key={name} style={{ background: i % 2 === 0 ? '#fff' : '#f4f6f8' }}>
              <td style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  display: 'inline-block', width: '10px', height: '10px',
                  borderRadius: '2px', background: COLORS[i % COLORS.length], flexShrink: 0,
                }} />
                {name}
              </td>
              <td style={{ padding: '6px 12px', textAlign: 'right' }}>{dollarFormatter(value)}</td>
              <td style={{ padding: '6px 12px', textAlign: 'right', color: '#777' }}>
                {((value / total) * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
