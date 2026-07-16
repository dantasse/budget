# Data model

Last verified against the code: 2026-07-12 (id-keyed catModel refactor). If you
change any layer below, update this file.

## Layer 0: YNAB (source of truth)

- Auth: personal access token, entered in the UI, stored in `localStorage.ynab_token`.
  Selected budget id in `localStorage.ynab_budget_id`.
- On budget load (`App.jsx`) two fetches run:
  - `GET /budgets/{id}/transactions?since_date=2000-01-01` (without `since_date`
    the API silently returns only the last year)
  - `GET /budgets/{id}/categories`
- `ynabCatInfo`: Map catId → `{ name, group, groupId }` derived from the fetch;
  deleted/hidden groups and categories are filtered out.
- `txSubsById` (ref): full subtransaction arrays per split transaction, because
  YNAB's PATCH for one subtransaction requires resending the complete array.

## Layer 1: rows

`toRows()` flattens transactions: **one row per transaction or subtransaction**.
Row key = `` `${_txId}/${_subTxId}` `` (`_subTxId` null for non-split). Fields:
`_categoryId`, `Account`, `Date`, `Payee`, `Category Group`, `Category`, `Memo`,
`Outflow`/`Inflow` (dollar strings from milliunits; exactly one nonzero).

Money convention everywhere: `netSpend(row) = Outflow − Inflow`. Displayed
"Spending" numbers are net.

## Layer 2: the scenario catModel (id-keyed category mapping)

A scenario is a local overlay on live YNAB data; `main` = live. Each scenario's
category changes live in **one materialized mapping** (the folded form of a
changelog), persisted at `localStorage.ynab_catmodel_{budgetId}_{scenario}`:

```js
{
  cats:   { [catId]: { name, group, splitFrom?, splitFromName? } },
  routes: { [ynabCatId]: catId },   // that category's transactions display as catId
  txCats: { [txKey]: catId },       // per-transaction exceptions
  groups: { [ynabGroupId]: newName } // group renames
}
```

- `catId` = a YNAB category id, or `local:{group}:{name}` for scenario-created
  categories (split parts).
- **Row resolution** (App.jsx, memoized):
  `catId = txCats[txKey] ?? routes[row._categoryId] ?? row._categoryId`, then
  name/group from `cats[catId] ?? ynabCatInfo` (YNAB groups pass through
  `groups[]` renames). Resolved rows carry the final `_categoryId` and, when it
  changed, `_ynabCategoryId` (the original — used for merge-child totals).
  Because keys are ids, **new YNAB transactions inherit all scenario ops**.
- **No-chains invariant**: `routes`/`txCats` values always point at final live
  catIds; every op flattens as it writes. Consequence: "ungroup" long after a
  merge can't restore per-tx assignments that were rewritten (⌘Z right after
  can — op undo restores a whole-model snapshot).
- **Ops** (App.jsx, each wrapped in `applyCatOp` = guard + snapshot-undo +
  persist): `renameCategory`, `moveCategory` (to another group), `renameGroup`,
  `mergeCategory`/`unmergeCategory`, `applySplit`/`removeSplit`,
  `recategorizeTx`. Splits: unassigned and future transactions follow the route
  to part 0; parts record `splitFrom` (ynab origin id) + `splitFromName`.
- **Memo edits** are the only remaining per-row patches:
  `localStorage.ynab_memoedits_{budgetId}_{scenario}`, applied before resolution.
- Edit routing: non-main → catModel/memoEdits. Main + "Edit live data" →
  single-tx category/memo edits PATCH YNAB and mutate `baseRows`; category ops
  (rename/merge/split/move) write main's catModel (they have no YNAB API
  equivalent). Main + toggle off → no-ops.
- `mergedCategoryGroups` (feeds the category dropdowns): YNAB categories not
  routed away, with overrides and group renames applied, plus local categories.
- Pre-refactor keys (`ynab_scenario_*`, `ynab_localcats_*`, `ynab_report_merges_*`,
  `ynab_report_splits_*`, `ynab_report_hidden_*`) are abandoned, not migrated.

### Date range

`allRows` = memo edits + resolution applied; `rows` = `allRows` filtered to the
header date pickers (defaults: one year ago → today; a cleared input means that
bound is unlimited). Tabs display `rows`. Ops operate on the catModel directly,
so they always cover every date.

## Layer 3: report-view state (display-only, per budget + scenario)

Rows arrive in ReportsTab fully resolved — it never re-derives categories.

| state | persisted at | what it does |
|---|---|---|
| `hiddenCatIds` (Set of catIds) | `ynab_report_hiddenids_*` | excluded from treemap; greyed in table |
| `lumpedGroups` (Set of group names) | `ynab_report_lumps_*` | group renders as one treemap cell |
| `zoomedGroup`, `payeeSplitCats`, selections, `tableSort` | in-memory | zoom view, payee breakdown, detail panel, table sort |

The old display-only "merges" are gone: drag-merge now calls the real
`mergeCategory` op, so the table and treemap can no longer disagree about
merges. Merge subrows in the table come from `mergeChildren` (App-derived from
`routes`); their totals use `_ynabCategoryId`.

The split editor's in-progress state (`editingSplit`, with the Naive Bayes
payee classifier) is in-memory only; Save converts it into an `applySplit` op.

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

- Treemap/table cells filter to `value > 0`: net-negative categories silently
  vanish from the treemap (and a lumped group with net ≤ 0 disappears entirely,
  including its un-lump button — recover via `ynab_report_lumps_*`).
- View state that is still name-keyed: `lumpedGroups`, `payeeSplitCats`,
  `selectedCategory` — same-named categories in different groups can collide
  there. Id-based selection is a possible follow-up.
- Split part ids are `local:{group}:{name}`, so renaming/moving a part keeps
  the old id string (harmless, just no longer descriptive).
