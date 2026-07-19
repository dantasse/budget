# Data model

Last verified against the code: 2026-07-18 (arbitrary-depth category tree). If
you change any layer below, update this file.

## Layer 0: YNAB (source of truth)

- Auth: personal access token, entered in the UI, stored in `localStorage.ynab_token`.
  Selected budget id in `localStorage.ynab_budget_id`.
- On budget load (`App.jsx`) two fetches run:
  - `GET /budgets/{id}/transactions?since_date=2000-01-01` (without `since_date`
    the API silently returns only the last year)
  - `GET /budgets/{id}/categories`
- YNAB has exactly two category levels: "category group" and "category". In our
  tree they become depth-1 and depth-2 nodes (see Layer 2). Hidden groups and
  categories are kept, flagged `hidden` (their transactions still display;
  they're just excluded from category pickers). Deleted ones are dropped.
- `ynabCatInfo`: Map catId → `{ name, group, groupId }`, used for stamping raw
  rows and for live PATCHes.
- `txSubsById` (ref): full subtransaction arrays per split transaction, because
  YNAB's PATCH for one subtransaction requires resending the complete array.

## Layer 1: rows

`toRows()` flattens transactions: **one row per transaction or subtransaction**.
Row key = `` `${_txId}/${_subTxId}` `` (`_subTxId` null for non-split). Fields:
`_categoryId`, `Account`, `Date`, `Payee`, `Category Group`, `Category`, `Memo`,
`Outflow`/`Inflow` (dollar strings from milliunits; exactly one nonzero).

After resolution (Layer 2) each row also carries `_path` (array of node names,
root → resolved node). `Category Group` = `_path[0]`; `Category` = the rest of
the path joined with " / " (empty for a transaction sitting directly on a
depth-1 node). Rows whose category id is unknown to the tree keep their
YNAB-stamped names and have no `_path`; reports skip them.

Money convention everywhere: `netSpend(row) = Outflow − Inflow`. Displayed
"Spending" numbers are net.

## Layer 2: the scenario catModel (category tree)

A scenario is a local overlay on live YNAB data; `main` = live. Each scenario's
category changes live in **one materialized mapping** (the folded form of a
changelog), persisted at `localStorage.ynab_cattree_{budgetId}_{scenario}`:

```js
{
  nodes:  { [nodeId]: { name?, parentId?, merged? } },
  routes: { [ynabCatId]: nodeId },  // that category's transactions display as nodeId
  txCats: { [txKey]: nodeId },      // per-transaction exceptions
}
```

- **The tree**: categories form a single tree of arbitrary depth. The base tree
  comes from YNAB (groups = depth-1 nodes with `parentId: null`, categories =
  depth-2 nodes under their group). `nodes` is an overlay on that base:
  - For a YNAB id: a partial override — `name` (rename), `parentId` (moved
    anywhere in the tree, including to `null` = top level), or
    `merged: true` (a tombstone: this node was absorbed into another node and
    no longer exists in the tree; always paired with a `routes` entry saying
    where its transactions went).
  - For a local id (`local:{uuid}`): the full definition `{ name, parentId }`.
    Local nodes are created by splits (and can then be renamed/moved like any
    node).
- **Effective tree** (`catTree` in App.jsx, memoized): base + overlay, merged
  tombstones removed, `childIds` computed. A node whose parent is missing
  (e.g. deleted in YNAB) surfaces as a root rather than disappearing.
- **Row resolution** (App.jsx, memoized):
  `nodeId = txCats[txKey] ?? routes[row._categoryId] ?? row._categoryId`, then
  name/path from the effective tree. Resolved rows carry the final
  `_categoryId`/`_path` and, when it changed, `_ynabCategoryId` (the original —
  used for merge-child totals). Because keys are ids, **new YNAB transactions
  inherit all scenario ops**. Transactions may sit on *any* node, including
  inner nodes and depth-1 nodes.
- **No-chains invariant**: `routes`/`txCats` values always point at live node
  ids; every op flattens as it writes. Consequence: "ungroup" long after a
  merge can't restore per-tx assignments that were rewritten (⌘Z right after
  can — op undo restores a whole-model snapshot).
- **Ops** (App.jsx, each wrapped in `applyCatOp` = guard + snapshot-undo +
  persist):
  - `renameNode(id, name)`
  - `moveNode(id, newParentId)` — reparents the node (with its whole subtree)
    anywhere; refuses (error banner) a move into the node's own subtree.
  - `mergeNode(fromId, intoId)` — `from`'s children reparent under `into`,
    `from`'s transactions re-route to `into`, and `from` leaves the tree
    (tombstone for YNAB ids, deleted outright for local ids). Refused when
    `into` is inside `from`'s subtree.
  - `unmergeNode(fromId)` — removes the route + tombstone; the YNAB node
    reappears at its (possibly overridden) parent. Children that were
    reparented by the merge stay where they are.
  - `splitNode(sourceId, partNames, assignments)` — creates one local child
    node per part *under* `sourceId` (the split source stays in the tree as
    the parent). Unassigned and future transactions follow a route to part 0;
    `assignments` writes `txCats` for the rest. The old `splitFrom` marker is
    gone: the parent link *is* the split relationship.
  - `absorbChildren(id)` — the inverse of split, generalized: every descendant
    of `id` merges into `id` (local descendants deleted, YNAB descendants
    tombstoned + routed). This is "remove split", and also works as a
    permanent lump of any subtree.
  - `recategorizeTx(keys, nodeId)` — per-transaction `txCats` entries; a
    transaction can be put on any node (this beats `routes`, so a split
    parent can still hold direct transactions).
- **Memo edits** are the only remaining per-row patches:
  `localStorage.ynab_memoedits_{budgetId}_{scenario}`, applied before resolution.
- Edit routing: non-main → catModel/memoEdits. Main + "Edit live data": a
  single-tx category change PATCHes YNAB when the target is a real YNAB
  category (depth-2 YNAB node); any other target (local node, depth-1 node)
  has no YNAB equivalent, so it writes main's catModel `txCats` instead. Memo
  edits PATCH YNAB. Category ops (rename/move/merge/split/absorb) always write
  main's catModel. Main + toggle off → no-ops.
- `catOptions` (feeds the category pickers): the effective tree flattened
  depth-first as `{ id, name, depth, path }`, hidden YNAB nodes excluded.
  Every node at every depth is pickable.
- `mergeChildren`: Map of live node id → `[{ id, name }]` of tombstoned YNAB
  categories routed into it (split routes don't appear here — a split's route
  targets a *child* of the source, and the source isn't tombstoned).
- **Future: merging back into YNAB.** Not built yet. The intended rule: every
  transaction rolls up to the depth-2 ancestor of its resolved node (nodes at
  depth ≥ 3 roll up their transactions; transactions sitting on a depth-1
  node, or under a locally created depth-1/2 node, have no YNAB image and
  will need explicit handling).
- Pre-refactor keys (`ynab_catmodel_*` and older) are abandoned, not migrated.

### Date range

`allRows` = memo edits + resolution applied; `rows` = `allRows` filtered to the
header date pickers (defaults: one year ago → today; a cleared input means that
bound is unlimited). Tabs display `rows`. Ops operate on the catModel directly,
so they always cover every date.

## Layer 3: report-view state (display-only, per budget + scenario)

Rows arrive in ReportsTab fully resolved — it never re-derives categories. It
also receives `catTree` for structure. All view state is node-id-keyed.

The treemap always shows **two tree levels at a time**: the children of the
current zoom root as outer boxes, and inside each box its child subtrees as
cells (each cell's value = that subtree's total). Zooming into a box makes it
the new root, so any depth is reachable; a breadcrumb in the header zooms back
out to any ancestor or the top.

| state | persisted at | what it does |
|---|---|---|
| `hiddenIds` (Set of node ids) | `ynab_report_hiddennodes_*` | node + subtree excluded from treemap; greyed in table |
| `lumpedIds` (Set of node ids) | `ynab_report_lumpnodes_*` | that box renders as a single cell (subtree total) instead of per-child cells — "lump" at any layer |
| `zoom root`, `payeeSplitIds`, selections, `tableSort` | in-memory | zoom, payee breakdown, detail panel, table sort |

Cell rules inside a box for node C:
- C lumped, or C has no children → one cell spanning C's subtree. A lone
  self-cell doesn't repeat C's name (the box label already shows it), just the
  total. With payee split toggled on such a box, the cell breaks into payees.
- otherwise → one cell per child of C, plus (when nonzero) a cell for
  transactions sitting directly on C.

Drag a cell onto another cell's label = `mergeNode`; onto a box background =
`moveNode` into that box's node. Right-click a cell = split / absorb children.
Clicking a box label renames the node.

The table below lists every node that holds transactions directly (its
"Spending" is the direct total, not the subtree total), with its ancestor path,
a hide toggle, and merge-child subrows (from `mergeChildren`, totals via
`_ynabCategoryId`).

The split editor's in-progress state (`editingSplit`, with the Naive Bayes
payee classifier) is in-memory only; Save converts it into a `splitNode` op.
It operates on the rows sitting *directly* on the source node. It opens from a
leaf box's "split" button, a cell's context menu, or the detail panel; part 0
(the remainder that unassigned/future transactions follow) starts named
"Other", so both parts read as children of the source rather than a copy of it.

## The Categories tab

Renders the effective tree as an indented list with subtree totals (hidden
YNAB nodes greyed). Dragging a row onto another row re-parents it there
(`moveNode`, whole subtree comes along); dropping on the "Top level" bar makes
it a root. Clicking a name renames it (`renameNode`); the ▾/▸ arrow collapses
or expands a subtree (in-memory only). Otherwise it's a direct view of
`catTree`.

## Undo

One app-wide, in-memory `undoStack` in `App.jsx`; ⌘Z/Ctrl-Z and the single Undo
button pop it. Entries `{ label?, scope, undo }`:

- `scope: 'edits'` — catModel op snapshots + memo-edit snapshots. Survive tab
  switches; not pushed on main (live YNAB edits can't be reverted locally,
  except main-catModel ops which are snapshots like any other).
- `scope: 'reports'` — view toggles (lump, payee-split); pruned when ReportsTab
  unmounts (their closures die with it).
- `scope: 'splitEditor'` — assignment moves inside the open split editor;
  pruned whenever the editor closes.

Whole stack cleared on budget or scenario switch. No redo.

## URL / navigation

Path is `/{scenario}/{tab}`, read once at startup, then kept in sync with
`history.replaceState`. Unknown scenario/tab → error banner + fallback.

## Known cruft / TODOs

- Treemap/table cells filter to `value > 0`: net-negative subtrees silently
  vanish from the treemap (and a lumped box with net ≤ 0 disappears entirely,
  including its un-lump button — they're listed in the "not shown" strip).
- `unmergeNode` restores the node but not children that the merge reparented,
  and not `txCats` that were flattened (only immediate ⌘Z can, via snapshot).
- Local node ids are opaque uuids; nothing garbage-collects a local node that
  ends up empty (harmless: it just shows as a zero cell / picker entry).
