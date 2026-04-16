import { useState, useMemo } from 'react'

function groupKey(g)  { return `group:${g}` }
function catKey(g, c) { return `cat:${g}:${c}` }

function SelectButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: '11px',
        padding: '1px 6px',
        cursor: 'pointer',
        border: '1px solid #aaa',
        borderRadius: '3px',
        background: '#f4f4f4',
        color: '#555',
      }}
    >
      select
    </button>
  )
}

export default function CategoriesTab({ rows, selectedGroups, onSelectedGroupsChange }) {
  const [collapsed, setCollapsed] = useState({})

  const tree = useMemo(() => {
    const groups = new Map()
    for (const row of rows) {
      const group = row['Category Group']
      const category = row['Category']
      if (!group) continue
      if (!groups.has(group)) groups.set(group, new Set())
      if (category) groups.get(group).add(category)
    }
    return [...groups.entries()].map(([group, cats]) => ({
      group,
      categories: [...cats].sort(),
    })).sort((a, b) => a.group.localeCompare(b.group))
  }, [rows])

  // Initialize selection to all groups when tree first loads
  const selected = useMemo(() => {
    if (selectedGroups !== null) return selectedGroups
    if (tree.length === 0) return new Set()
    return new Set(tree.map(({ group }) => groupKey(group)))
  }, [selectedGroups, tree])

  const setSelected = (updater) => {
    onSelectedGroupsChange(prev => {
      const resolved = prev !== null ? prev : new Set(tree.map(({ group }) => groupKey(group)))
      return typeof updater === 'function' ? updater(resolved) : updater
    })
  }

  const toggleCollapse = (group) =>
    setCollapsed(prev => ({ ...prev, [group]: !prev[group] }))

  // Clicking a child drills in: deselects parent, selects all siblings.
  // If already at category level, clicking does nothing (use "select" button to re-add).
  const handleCatClick = (group, categories) => {
    setSelected(prev => {
      if (!prev.has(groupKey(group))) return prev  // already drilled in, do nothing
      const next = new Set(prev)
      next.delete(groupKey(group))
      categories.forEach(c => next.add(catKey(group, c)))
      return next
    })
  }

  const selectGroup = (group) => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const k of next) {
        if (k.startsWith(`cat:${group}:`)) next.delete(k)
      }
      next.add(groupKey(group))
      return next
    })
  }

  const selectCat = (group, categories) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.delete(groupKey(group))
      categories.forEach(c => next.add(catKey(group, c)))
      return next
    })
  }

  const isGroupSelected = (group) => selected.has(groupKey(group))
  const isCatSelected   = (group, cat) => selected.has(catKey(group, cat))

  if (rows.length === 0) return (
    <div style={{ color: '#555', padding: '24px 0' }}>No data loaded.</div>
  )

  return (
    <div style={{ fontSize: '14px', lineHeight: '1.8' }}>
      {tree.map(({ group, categories }) => (
        <div key={group}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }}>
            <div
              onClick={() => toggleCollapse(group)}
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                fontWeight: '600',
                color: isGroupSelected(group) ? '#1a7a3c' : 'inherit',
              }}
            >
              {collapsed[group] ? '▶' : '▼'} {group}
            </div>
            {!isGroupSelected(group) && (
              <SelectButton onClick={() => selectGroup(group)} />
            )}
          </div>
          {!collapsed[group] && (
            <div style={{ marginLeft: '36px' }}>
              {categories.map((cat, idx) => {
                const isLast = idx === categories.length - 1
                const selected_ = isCatSelected(group, cat)
                return (
                  <div key={cat} style={{ display: 'flex', alignItems: 'center' }}>
                    <div style={{ position: 'relative', width: '20px', alignSelf: 'stretch', flexShrink: 0 }}>
                      <div style={{
                        position: 'absolute', left: 0, top: 0,
                        bottom: isLast ? '50%' : 0,
                        borderLeft: '1px solid #bbb',
                      }} />
                      <div style={{
                        position: 'absolute', left: 0, top: '50%',
                        width: '100%', borderTop: '1px solid #bbb',
                      }} />
                    </div>
                    <div
                      onClick={() => handleCatClick(group, categories)}
                      style={{
                        padding: '1px 0 1px 6px',
                        cursor: isGroupSelected(group) ? 'pointer' : 'default',
                        userSelect: 'none',
                        color: selected_ ? '#1a7a3c' : '#888',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      {cat}
                      {!selected_ && <SelectButton onClick={(e) => { e.stopPropagation(); selectCat(group, categories) }} />}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
