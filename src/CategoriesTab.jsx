import { useState, useEffect, useMemo } from 'react'

function parseMoney(val) {
  if (!val) return 0
  return parseFloat(val.replace(/[$,]/g, '')) || 0
}

function netSpend(row) {
  return parseMoney(row['Outflow']) - parseMoney(row['Inflow'])
}

const dollarFormatter = (value) =>
  '$' + value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

const ROOT = '__root__'

// The category hierarchy as an indented tree; drag a row onto another row to
// re-parent it (with its whole subtree), or onto the top bar to make it a root.
// Clicking a name edits it in place.
export default function CategoriesTab({ catTree, rows, onMoveNode, onRenameNode, onDeleteNode }) {
  const tree = catTree.byId
  const [dragId,  setDragId]  = useState(null)
  const [hoverId, setHoverId] = useState(null) // hovered drop target: node id, or ROOT
  const [editing, setEditing] = useState(null) // { id, value } | null
  const [collapsedIds, setCollapsedIds] = useState(new Set()) // subtrees folded shut (in-memory)

  useEffect(() => {
    if (!dragId) return
    const cancel = () => { setDragId(null); setHoverId(null) }
    document.addEventListener('mouseup', cancel)
    return () => document.removeEventListener('mouseup', cancel)
  }, [dragId])

  useEffect(() => {
    document.body.style.cursor = dragId ? 'grabbing' : ''
    return () => { document.body.style.cursor = '' }
  }, [dragId])

  const directTotals = useMemo(() => {
    const m = new Map()
    for (const row of rows) {
      const id = row._categoryId
      if (!id || !tree.has(id)) continue
      const net = netSpend(row)
      if (net === 0) continue
      m.set(id, (m.get(id) ?? 0) + net)
    }
    return m
  }, [rows, tree])

  const subtreeTotal = useMemo(() => {
    const cache = new Map()
    const calc = (id) => {
      if (cache.has(id)) return cache.get(id)
      let v = directTotals.get(id) ?? 0
      for (const c of tree.get(id).childIds) v += calc(c)
      cache.set(id, v)
      return v
    }
    return calc
  }, [tree, directTotals])

  const list = useMemo(() => {
    const out = []
    const visit = (id, depth) => {
      const n = tree.get(id)
      out.push({ id, depth, name: n.name, hidden: n.hidden, parentId: n.parentId, hasChildren: n.childIds.length > 0 })
      if (collapsedIds.has(id)) return
      for (const c of n.childIds) visit(c, depth + 1)
    }
    for (const r of catTree.rootIds) visit(r, 0)
    return out
  }, [catTree, collapsedIds])

  const toggleCollapsed = (id) =>
    setCollapsedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const drop = (targetId) => {
    if (dragId !== null && dragId !== targetId) onMoveNode(dragId, targetId)
    setDragId(null)
    setHoverId(null)
  }

  return (
    <div style={{ maxWidth: '640px' }}>
      <p style={{ fontSize: '13px', color: '#777', margin: '0 0 12px' }}>
        Drag a category onto another to make it a subcategory; drop it on the bar below to make it top-level.
      </p>
      <div
        onMouseEnter={() => { if (dragId) setHoverId(ROOT) }}
        onMouseLeave={() => { if (hoverId === ROOT) setHoverId(null) }}
        onMouseUp={() => { if (dragId) drop(null) }}
        style={{
          padding: '8px 12px', marginBottom: '12px', fontSize: '13px',
          border: `2px dashed ${hoverId === ROOT && dragId ? '#2980b9' : '#ccc'}`,
          borderRadius: '6px', color: dragId ? '#2980b9' : '#999',
          background: hoverId === ROOT && dragId ? '#eaf3fb' : 'transparent',
        }}
      >
        Top level
      </div>
      {list.map(({ id, depth, name, hidden, parentId, hasChildren }) => {
        const isDropTarget = dragId && hoverId === id && dragId !== id
        return (
          <div
            key={id}
            data-node-id={id}
            data-parent-id={parentId ?? ''}
            onMouseDown={e => { e.preventDefault(); setDragId(id) }}
            onMouseEnter={() => { if (dragId) setHoverId(id) }}
            onMouseLeave={() => { if (hoverId === id) setHoverId(null) }}
            onMouseUp={() => { if (dragId && dragId !== id) drop(id) }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '5px 8px', marginLeft: depth * 28 + 'px',
              fontSize: '13px', borderRadius: '4px', userSelect: 'none',
              cursor: dragId ? (dragId === id ? 'grabbing' : 'copy') : 'grab',
              opacity: dragId === id ? 0.4 : hidden ? 0.5 : 1,
              background: isDropTarget ? '#eaf3fb' : 'transparent',
              outline: isDropTarget ? '2px solid #2980b9' : 'none',
              outlineOffset: '-2px',
            }}
          >
            <span
              onMouseDown={e => e.stopPropagation()}
              onClick={hasChildren ? () => toggleCollapsed(id) : undefined}
              style={{ color: hasChildren ? '#888' : '#bbb', fontSize: '11px', width: '12px', textAlign: 'center', cursor: hasChildren ? 'pointer' : 'default', flexShrink: 0 }}
            >
              {hasChildren ? (collapsedIds.has(id) ? '▸' : '▾') : '·'}
            </span>
            {editing?.id === id ? (
              <input
                autoFocus
                value={editing.value}
                onChange={e => setEditing(prev => ({ ...prev, value: e.target.value }))}
                onMouseDown={e => e.stopPropagation()}
                onBlur={() => { onRenameNode(id, editing.value); setEditing(null) }}
                onKeyDown={e => {
                  if (e.key === 'Enter')  { onRenameNode(id, editing.value); setEditing(null) }
                  if (e.key === 'Escape') setEditing(null)
                }}
                style={{ fontSize: '13px', fontWeight: hasChildren ? 600 : 400, color: '#2c3e50', fontFamily: 'inherit', border: 'none', outline: 'none', borderBottom: '1px solid #2980b9', background: 'transparent', padding: 0, width: '180px' }}
              />
            ) : (
              <span
                onClick={() => setEditing({ id, value: name })}
                style={{ fontWeight: hasChildren ? 600 : 400, color: '#2c3e50', cursor: 'text' }}
              >
                {name}
              </span>
            )}
            {hidden && <span style={{ fontSize: '11px', color: '#999' }}>(hidden in YNAB)</span>}
            <span style={{ marginLeft: 'auto', color: '#777' }}>{dollarFormatter(subtreeTotal(id))}</span>
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => onDeleteNode(id)}
              style={{ fontSize: '11px', padding: '1px 7px', cursor: 'pointer', border: '1px solid #bbb', borderRadius: '3px', background: '#f4f4f4', color: '#555' }}
            >
              delete
            </button>
          </div>
        )
      })}
    </div>
  )
}
