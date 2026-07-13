# Data model

Last verified against the code: 2026-07-11. If you change any layer below, update this file.

## Layer 0: YNAB (source of truth)

- Auth: personal access token, entered in the UI, stored in `localStorage.ynab_token`.
  Selected budget id in `localStorage.ynab_budget_id`.
- On budget load (`App.jsx`) two fetches run:
  - `GET /budgets/{id}/transactions?since_date=2000-01-01` (without `since_date`
    the API silently returns only the last year)
  - `GET /budgets/{id}/categories`
- `txSubsById` (ref, not state): `Map<txId, subtransaction[]>` for split
  transactions. Kept because YNAB's PATCH for one subtransaction requires
  resending the *complete* subtransactions array.
- Deleted transactions/subtransactions and deleted/hidden category groups are
  filtered out at load.

## Layer 1: rows (`baseRows` → `rows`)

`toRows()` flattens transactions: **one row per transaction, or one row per
subtransaction** for splits. A row is a flat object:

| field | meaning |
|---|---|
| `_txId`, `_subTxId` | YNAB ids; `_subTxId` is `null` for non-split. Row key = `` `${_txId}/${_subTxId}` `` |
| `_categoryId` | YNAB category id, or a local id (see localCategories) |
| `Account`, `Date`, `Payee`, `Memo` | strings |
| `Category Group`, `Category` | denormalized *names*, not ids |
| `Outflow`, `Inflow` | dollar **strings** ("12.34"), converted from YNAB milliunits; exactly one is nonzero |

Money convention everywhere downstream: `netSpend(row) = Outflow − Inflow`
(so refunds/inflows reduce spending). Displayed "Spending" numbers are net.

### Date range

App derives two row sets: `allRows` (all transactions, scenario edits
applied) and `rows` (`allRows` filtered to the header date pickers; defaults:
one year ago → today; a cleared input means that bound is unlimited). Tabs
and reports display `rows`. Bulk name-based edits — `moveCategory`,
`renameGroup`, `applySplit` — and the `mergedCategoryGroups` safety net use
`allRows`, so they always cover every date. When a split is saved, rows the
split editor never showed (outside the range) have no assignment and land in
part 0 — the classifier only ran on visible rows.

## Layer 2: scenarios (branching)

A scenario is a named local overlay on the live data. `main` = live YNAB.

- Scenario list: `localStorage.ynab_scenarios_{budgetId}`.
- `scenarioEdits`: `{ [rowKey]: partialRowPatch }`, persisted at
  `localStorage.ynab_scenario_{budgetId}_{scenarioName}`.
  `rows = applyEdits(baseRows, scenarioEdits)` — a shallow merge per row.
- `localCategories`: `{ [id]: { name, groupName } }`, persisted at
  `localStorage.ynab_localcats_{budgetId}_{scenarioName}`. These are
  scenario-only categories (created by saving a split); ids look like
  `local:{groupName}:{catName}`. `mergedCategoryGroups` = YNAB groups +
  local categories + a safety net for category ids referenced in rows but
  known nowhere else.
- Edit routing (`updateCategory` / `bulkUpdateCategory` / `updateMemo` /
  `moveCategory` / `renameGroup` / `applySplit`):
  - **Non-main scenario** → write to `scenarioEdits` only. Undoable via
    `editUndoStack` (in-memory, not persisted).
  - **Main + "Edit live data" on** → PATCH the YNAB API and update `baseRows`
    in place. Not undoable.
  - **Main + edit toggle off** → no-op (functions return early).
- `moveCategory` / `renameGroup` are implemented as bulk row edits (they patch
  `Category Group` on every matching row), not as first-class group objects.

## Layer 3: report-view state (display-only, per budget + scenario)

All in `ReportsTab`, persisted to localStorage, keyed
`ynab_report_{kind}_{budgetId}_{scenario}`:

| kind | shape | what it does |
|---|---|---|
| `hidden` | `Set<categoryName>` | excluded from treemap; greyed with "—" share in the table |
| `merges` | `Map<childName, parentName>` | child's total rolls into parent **in the left table only** |
| `splits` | `Map<catName, {parts, assignments, manualKeys}>` | provisional split of one category into parts, with per-row assignments (Naive Bayes autoclassifier for unassigned rows). Applied **in the treemap only** until "Save", which converts it into real `scenarioEdits` + `localCategories` and deletes the view-level entry |
| `lumps` | `Set<groupName>` | group renders as one treemap cell (all its rows collapse to the group name) **in the treemap only** |

Everything in layer 3 is keyed by *name* (not id), so renames can orphan
entries silently.

## Undo

One app-wide, in-memory `undoStack` in `App.jsx`; ⌘Z/Ctrl-Z and the single
Undo button (tab bar) pop it. Entries are `{ label?, scope, key?, undo }`
where `undo` is a closure that reverses the action:

- `scope: 'edits'` — scenario-edit snapshots (category/memo/split changes).
  Not pushed on main (live YNAB edits can't be reverted locally).
- `scope: 'reports'` — merges, group moves, lump/split toggles.
- `scope: 'splitEditor'` — assignment moves inside the open split editor;
  pruned whenever the editor closes (their closures reference the open
  editor's state).

Reports/splitEditor closures capture ReportsTab state setters, so ReportsTab
prunes both scopes on unmount (i.e., switching to the Transactions tab
forgets Reports undos — same as when each tab had its own stack). The whole
stack is cleared on budget or scenario switch. No redo.

## The two Reports aggregations (they disagree by design/hack)

- `allData` → the left table. Sums `netSpend` per label, applies **merges**
  only. Shows negative values as-is. Hidden categories still listed (greyed).
- `twoLevelData` → the treemap. Group → category hierarchy; applies
  **hidden, splits, lumps** (not merges); then filters cells to `value > 0`
  and drops empty groups. Consequences:
  - Net-negative categories silently vanish from the treemap.
  - A lumped group whose total net ≤ 0 vanishes entirely — including its
    un-lump button, which only renders on visible groups (no UI way back;
    clear the `ynab_report_lumps_*` key).

## URL / navigation

Path is `/{scenario}/{tab}`, read once at startup, then kept in sync with
`history.replaceState`. Unknown scenario/tab in the URL → error banner +
fallback.

## Known cruft / TODOs

- Commit `715e8d9`: "ugh this is a hack, todo fix the data model" — the
  name-keyed, three-layer split between scenarioEdits / report-view state /
  YNAB is the hack in question.
- Merges affect the table but not the treemap; view-level splits affect the
  treemap but not the table.
