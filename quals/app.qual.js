import { test, expect } from '@playwright/test'
import { launchApp, createScenario, BUDGETS, TRANSACTIONS, CATEGORIES } from './fixtures.js'

const label = (page, name) => page.locator(`[data-label-for="${name}"]`)

test('transactions tab renders fixture rows', async ({ page }) => {
  await launchApp(page)
  await expect(page.getByText('Landlord LLC').first()).toBeVisible()
  await expect(page.getByText('Noodle House').first()).toBeVisible()
  // outside the default one-year date range
  await expect(page.getByText('Ancient Payee')).toHaveCount(0)
})

test('transactions category column shows the full path', async ({ page }) => {
  await launchApp(page)
  await expect(page.getByText('Category Group')).toHaveCount(0)
  // rows sort by date desc; the newest fixture tx (Corner Grocer) is in Essentials → Groceries
  await expect(page.locator('tbody select').first().locator('option').first())
    .toHaveText('Essentials → Groceries')
})

test('date pickers widen and narrow the visible rows', async ({ page }) => {
  await launchApp(page)
  await expect(page.getByText('Landlord LLC').first()).toBeVisible()
  const [startInput, endInput] = await page.locator('input[type="date"]').all()
  await startInput.fill('2020-01-01')
  await expect(page.getByText('Ancient Payee')).toBeVisible()
  await endInput.fill('2020-06-01')
  await expect(page.getByText('Landlord LLC')).toHaveCount(0)
})

test('reports loaded directly by URL shows group labels with buttons', async ({ page }) => {
  // regression: labels never rendered when ReportsTab mounted before data arrived
  await launchApp(page, '/main/Reports')
  await expect(label(page, 'Essentials')).toBeVisible()
  await expect(label(page, 'Fun')).toBeVisible()
  await expect(label(page, 'Essentials').getByRole('button', { name: 'lump' })).toBeVisible()
  await expect(label(page, 'Essentials').getByRole('button', { name: 'zoom' })).toBeVisible()
})

test('lump collapses a group and undo restores it', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  // prefix matches throughout: cell labels are truncated ("Grocer…") to fit their rects
  await expect(page.locator('svg text', { hasText: /^Groc/ })).toBeVisible()
  await label(page, 'Essentials').getByRole('button', { name: 'lump' }).click()
  await expect(page.locator('svg text', { hasText: /^Groc/ })).toHaveCount(0)
  // the lumped cell shows only its total; the title lives in the group-label overlay
  await expect(page.locator('svg text', { hasText: /^Essentials/ })).toHaveCount(0)
  await expect(page.locator('svg text', { hasText: /^\$1,888$/ })).toBeVisible()
  await expect(label(page, 'Essentials').getByRole('button', { name: 'unlump' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('svg text', { hasText: /^Groc/ })).toBeVisible()
})

test('renaming a group in a scenario applies everywhere and persists', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await createScenario(page, 'qual-scenario')
  await label(page, 'Fun').locator('span span').first().click()
  const input = label(page, 'Fun').locator('input')
  await input.fill('Leisure')
  await input.press('Enter')
  await expect(label(page, 'Leisure')).toBeVisible()
  // reports table group column
  await expect(page.locator('td', { hasText: /^Leisure$/ }).first()).toBeVisible()
  await page.reload()
  await expect(label(page, 'Leisure')).toBeVisible()
})

test('recategorizing a transaction in a scenario updates and persists', async ({ page }) => {
  await launchApp(page)
  await createScenario(page, 'qual-scenario')
  const firstSelect = page.locator('tbody select').first()
  // options are the depth-indented tree, so select by id
  await firstSelect.selectOption('c-games')
  await expect(firstSelect).toHaveValue('c-games')
  await page.reload()
  await expect(page.locator('tbody select').first()).toHaveValue('c-games')
})

test('a transaction can sit on a depth-1 node', async ({ page }) => {
  await launchApp(page)
  await createScenario(page, 'qual-scenario')
  const firstSelect = page.locator('tbody select').first()
  await firstSelect.selectOption('g2') // the "Fun" category group itself
  await expect(firstSelect).toHaveValue('g2')
  await page.getByRole('button', { name: 'Reports', exact: true }).click()
  // its direct spend gets its own table row, with no ancestor path
  const funRow = page.locator('tr', { hasText: /^Fun/ }).filter({ has: page.getByRole('button', { name: 'hide' }) })
  await expect(funRow).toBeVisible()
})

test('drag-merge combines two categories and ungroup reverses it', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await createScenario(page, 'qual-scenario')
  const games = page.locator('svg text', { hasText: /^Games$/ })
  const restaurants = page.locator('svg text', { hasText: /^Rest/ })
  await expect(games).toBeVisible()
  const from = await games.boundingBox()
  const to = await restaurants.boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
  await page.mouse.up()
  // Games rolls into Restaurants: gone from treemap, listed as a merge child
  await expect(page.locator('svg text', { hasText: /^Games$/ })).toHaveCount(0)
  const childRow = page.locator('tr', { hasText: 'Games' }).filter({ has: page.getByRole('button', { name: 'ungroup' }) })
  await expect(childRow).toBeVisible()
  await childRow.getByRole('button', { name: 'ungroup' }).click()
  await expect(page.locator('svg text', { hasText: /^Games$/ })).toBeVisible()
})

test('split editor saves a split; parts nest under the source', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await createScenario(page, 'qual-scenario')
  // treemap texts are pointer-events:none; force dispatches to the cell rect beneath
  await page.locator('svg text', { hasText: /^Groc/ }).click({ button: 'right', force: true })
  await page.getByText('Split...').click()
  const partInputs = page.getByPlaceholder('Sub-category name')
  await partInputs.nth(1).fill('Coffee')
  // assign the Coffee Cart transaction to part 2
  await page.locator('div', { hasText: /^Coffee Cart/ }).locator('input[type="checkbox"]').last().check()
  await page.getByRole('button', { name: /Assign 1 here/ }).nth(1).click()
  await page.getByRole('button', { name: 'Save' }).click()
  // parts are children of Groceries: not at the top level, visible after zooming in
  await expect(page.locator('svg text', { hasText: /^Coffee$/ })).toHaveCount(0)
  await label(page, 'Essentials').getByRole('button', { name: 'zoom' }).click()
  await expect(page.locator('svg text', { hasText: /^Coffee$/ })).toBeVisible()
  // the scenario-local category shows up in the transactions dropdown
  await page.getByRole('button', { name: 'Transactions' }).click()
  await expect(page.locator('tbody select').first().locator('option', { hasText: /Coffee$/ })).toHaveCount(1)
  // the category column shows the full path down to the new part
  await expect(page.locator('tr', { hasText: 'Coffee Cart' }).locator('option').first())
    .toHaveText('Essentials → Groceries → Coffee')
})

test('splitter automatic mode assigns all rows with the same payee', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await createScenario(page, 'qual-scenario')
  await page.locator('svg text', { hasText: /^Groc/ }).click({ button: 'right', force: true })
  await page.getByText('Split...').click()
  // assign one of the two Corner Grocer transactions ($25); the other ($40) follows by payee
  // anchored to the full row text: an unanchored /^Corner Grocer/ also matches the column container
  await page.locator('div', { hasText: /^Corner Grocer\s*[\d-]+\s*25\.00$/ }).locator('input[type="checkbox"]').check()
  await page.getByRole('button', { name: /Assign 1 here/ }).nth(1).click()
  // part totals: both Corner Grocer txs ($65) moved; Farm Stand + Coffee Cart ($23) stayed in part 0
  await expect(page.getByText(/^\$65\s*2 transactions$/)).toBeVisible()
  await expect(page.getByText(/^\$23\s*2 transactions$/)).toBeVisible()
})

test('dragging a cell onto another box moves it there', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await createScenario(page, 'qual-scenario')
  const games = page.locator('svg text', { hasText: /^Games$/ })
  const rent  = page.locator('svg text', { hasText: /^Rent$/ })
  const from = await games.boundingBox()
  const to   = await rent.boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  // aim below Rent's label: the label hit-zone means merge, the background means move
  await page.mouse.move(to.x + to.width / 2, to.y + to.height + 30, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('tr', { hasText: 'Games' }).filter({ hasText: 'Essentials' })).toBeVisible()
})

test('absorb children reverses a split', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await createScenario(page, 'qual-scenario')
  await page.locator('svg text', { hasText: /^Groc/ }).click({ button: 'right', force: true })
  await page.getByText('Split...').click()
  await page.getByPlaceholder('Sub-category name').nth(1).fill('Coffee')
  await page.locator('div', { hasText: /^Coffee Cart/ }).locator('input[type="checkbox"]').last().check()
  await page.getByRole('button', { name: /Assign 1 here/ }).nth(1).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('td', { hasText: /^Coffee$/ })).toBeVisible()
  await page.locator('svg text', { hasText: /^Groc/ }).click({ button: 'right', force: true })
  await page.getByText('Absorb children').click()
  await expect(page.locator('td', { hasText: /^Coffee$/ })).toHaveCount(0)
})

test('lump and zoom work at any layer', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await createScenario(page, 'qual-scenario')
  await page.locator('svg text', { hasText: /^Groc/ }).click({ button: 'right', force: true })
  await page.getByText('Split...').click()
  await page.getByPlaceholder('Sub-category name').nth(1).fill('Coffee')
  // an empty part renders no cell, so give Coffee a transaction
  await page.locator('div', { hasText: /^Coffee Cart/ }).locator('input[type="checkbox"]').last().check()
  await page.getByRole('button', { name: /Assign 1 here/ }).nth(1).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await label(page, 'Essentials').getByRole('button', { name: 'zoom' }).click()
  await expect(page.locator('svg text', { hasText: /^Coffee$/ })).toBeVisible()
  // Groceries has children now, so it lumps at level 2
  await label(page, 'Groceries').getByRole('button', { name: 'lump' }).click()
  await expect(page.locator('svg text', { hasText: /^Coffee$/ })).toHaveCount(0)
  await label(page, 'Groceries').getByRole('button', { name: 'unlump' }).click()
  // and zooms to level 2; the breadcrumb offers both ancestors
  await label(page, 'Groceries').getByRole('button', { name: 'zoom' }).click()
  await expect(label(page, 'Coffee')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Essentials' })).toBeVisible()
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(label(page, 'Essentials')).toBeVisible()
})

test('net-negative categories and lumped groups are listed under the treemap', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  const bar = page.locator('div').filter({ hasText: /^Not shown \(net negative\):/ }).last()
  // Paycheck (income) nets negative: dropped from the map, listed below it
  await expect(page.locator('svg text', { hasText: /^Paycheck$/ })).toHaveCount(0)
  await expect(bar).toContainText('Paycheck')
  await expect(bar).toContainText('-$500')
  await expect(page.locator('svg text', { hasText: /^Transfer$/ })).toBeVisible()
  // lumping Custom folds Transfer into a net-negative cell: whole group leaves the map
  await label(page, 'Custom').getByRole('button', { name: 'lump' }).click()
  await expect(page.locator('svg text', { hasText: /^Transfer$/ })).toHaveCount(0)
  await expect(bar).toContainText('Custom (-$400)')
  await bar.getByRole('button', { name: 'unlump' }).click()
  await expect(page.locator('svg text', { hasText: /^Transfer$/ })).toBeVisible()
})

test('zoom shows categories, payee split narrows the detail panel', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await label(page, 'Essentials').getByRole('button', { name: 'zoom' }).click()
  await expect(label(page, 'Groceries')).toBeVisible()
  await expect(label(page, 'Rent')).toBeVisible()
  await label(page, 'Groceries').getByRole('button', { name: 'payees' }).click()
  const payeeBox = page.locator('svg text', { hasText: /^Corner/ }).first()
  await expect(payeeBox).toBeVisible()
  await payeeBox.click({ force: true })
  await expect(page.getByText('· Corner Grocer')).toBeVisible()
})

test('leaf split button opens the editor and creates child categories', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await createScenario(page, 'qual-scenario')
  await label(page, 'Essentials').getByRole('button', { name: 'zoom' }).click()
  await label(page, 'Groceries').getByRole('button', { name: 'split' }).click()
  await expect(page.getByText('Split:')).toBeVisible()
  // part 0 defaults to "Other" so both parts are real children, not a same-named copy
  await expect(page.getByPlaceholder('Sub-category name').nth(0)).toHaveValue('Other')
  await page.getByPlaceholder('Sub-category name').nth(1).fill('Coffee')
  await page.locator('div', { hasText: /^Coffee Cart/ }).locator('input[type="checkbox"]').last().check()
  await page.getByRole('button', { name: /Assign 1 here/ }).nth(1).click()
  await page.getByRole('button', { name: 'Save' }).click()
  // the Groceries box now shows its level-3 subcategories, not payees
  await expect(page.locator('svg text', { hasText: /^Coffee$/ })).toBeVisible()
  await expect(page.locator('svg text', { hasText: /^Other$/ })).toBeVisible()
})

test('categories tab drag re-parents a node', async ({ page }) => {
  await launchApp(page, '/main/Categories')
  await createScenario(page, 'qual-scenario')
  const games = page.locator('[data-node-id="c-games"]')
  await expect(games).toHaveAttribute('data-parent-id', 'g2')
  const target = page.locator('[data-node-id="g1"]')
  const from = await games.boundingBox()
  const to   = await target.boundingBox()
  await page.mouse.move(from.x + 20, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('[data-node-id="c-games"]')).toHaveAttribute('data-parent-id', 'g1')
  // undo restores the old parent
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('[data-node-id="c-games"]')).toHaveAttribute('data-parent-id', 'g2')
})

test('categories tab renames a node in place', async ({ page }) => {
  await launchApp(page, '/main/Categories')
  await createScenario(page, 'qual-scenario')
  await page.locator('[data-node-id="c-restaurants"]').getByText('Restaurants').click()
  const input = page.locator('[data-node-id="c-restaurants"] input')
  await input.fill('Dining')
  await input.press('Enter')
  await expect(page.locator('[data-node-id="c-restaurants"]')).toContainText('Dining')
  await page.reload()
  await expect(page.locator('[data-node-id="c-restaurants"]')).toContainText('Dining')
})

test('clicking Connect with an unchanged token reloads the data', async ({ page }) => {
  // regression: same-token setToken was a state no-op, so the fetch effects
  // never re-ran after Connect cleared budgets/baseRows
  await launchApp(page)
  await expect(page.getByText('Landlord LLC').first()).toBeVisible()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Landlord LLC').first()).toBeVisible()
})

test('reports shows Loading… (not No data loaded) while fetching', async ({ page }) => {
  let release
  const gate = new Promise(r => { release = r })
  await page.route('https://api.ynab.com/v1/budgets', r => r.fulfill({ json: BUDGETS }))
  await page.route('https://api.ynab.com/v1/budgets/b1/transactions**', async r => {
    await gate
    await r.fulfill({ json: TRANSACTIONS })
  })
  await page.route('https://api.ynab.com/v1/budgets/b1/categories', r => r.fulfill({ json: CATEGORIES }))
  await page.addInitScript(() => {
    localStorage.setItem('ynab_token', 'qual-token')
    localStorage.setItem('ynab_budget_id', 'b1')
  })
  await page.goto('/main/Reports')
  // the tab body message plus the app-level banner
  await expect(page.getByText('Loading…')).toHaveCount(2)
  await expect(page.getByText('No data loaded.')).toHaveCount(0)
  release()
  await expect(label(page, 'Essentials')).toBeVisible()
})

test('deleting a category keeps its transactions stamped and out of reports; undo restores it', async ({ page }) => {
  await launchApp(page, '/main/Categories')
  await createScenario(page, 'qual-scenario')
  await page.locator('[data-node-id="c-games"]').getByRole('button', { name: 'delete' }).click()
  await expect(page.locator('[data-node-id="c-games"]')).toHaveCount(0)
  // its transactions keep the stamped YNAB path in the transactions view
  await page.getByRole('button', { name: 'Transactions' }).click()
  await expect(page.locator('tr', { hasText: 'Game Shop' }).locator('option').first())
    .toHaveText('Fun → Games')
  // and reports skip them
  await page.getByRole('button', { name: 'Reports', exact: true }).click()
  await expect(page.locator('svg text', { hasText: /^Games/ })).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('svg text', { hasText: /^Games/ })).toBeVisible()
})

test('deleting a group removes its whole subtree and persists', async ({ page }) => {
  await launchApp(page, '/main/Categories')
  await createScenario(page, 'qual-scenario')
  await page.locator('[data-node-id="g2"]').getByRole('button', { name: 'delete' }).click()
  await expect(page.locator('[data-node-id="g2"]')).toHaveCount(0)
  await expect(page.locator('[data-node-id="c-games"]')).toHaveCount(0)
  await expect(page.locator('[data-node-id="c-restaurants"]')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-node-id="g1"]')).toBeVisible()
  await expect(page.locator('[data-node-id="g2"]')).toHaveCount(0)
})

test('Reports2 payee buckets moves a payee into a new child category', async ({ page }) => {
  await launchApp(page, '/main/Reports2')
  await createScenario(page, 'qual-scenario')
  await page.getByTitle('source category').selectOption('c-groceries')
  await page.getByRole('button', { name: /^Corner Grocer/ }).click()
  await page.getByRole('button', { name: '+ New subcategory' }).click()
  await page.getByPlaceholder('New category name').fill('Stores')
  await page.getByRole('button', { name: 'Move 1 here' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Transactions' }).click()
  await expect(page.locator('tr', { hasText: 'Corner Grocer' }).first().locator('option').first())
    .toHaveText('Essentials → Groceries → Stores')
})

test('Reports3 search & carve creates a sibling category from matches', async ({ page }) => {
  await launchApp(page, '/main/Reports3')
  await createScenario(page, 'qual-scenario')
  await page.getByTitle('source category').selectOption('c-groceries')
  await page.getByPlaceholder('Search payee or memo…').fill('coffee')
  await expect(page.getByText('1 transactions match, $8')).toBeVisible()
  await page.getByPlaceholder('New category name').fill('Coffee')
  await page.getByLabel(/sibling/).check()
  await page.getByRole('button', { name: 'Carve out' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Transactions' }).click()
  await expect(page.locator('tr', { hasText: 'Coffee Cart' }).locator('option').first())
    .toHaveText('Essentials → Coffee')
})

test('Reports4 triage deck deals payees largest-first into buckets', async ({ page }) => {
  await launchApp(page, '/main/Reports4')
  await createScenario(page, 'qual-scenario')
  await page.getByTitle('source category').selectOption('c-groceries')
  // largest payee first: Corner Grocer ($65) → new bucket
  await expect(page.getByText('Corner Grocer')).toBeVisible()
  await page.getByRole('button', { name: '+ New bucket' }).click()
  await page.getByPlaceholder('New category name').fill('Stores')
  await page.getByRole('button', { name: 'Create & assign' }).click()
  // Farm Stand ($15) → same bucket; Coffee Cart ($8) → keep in Groceries
  await expect(page.getByText('Farm Stand')).toBeVisible()
  await page.getByRole('button', { name: /^Stores/ }).click()
  await expect(page.getByText('Coffee Cart')).toBeVisible()
  await page.getByRole('button', { name: /^Keep in Groceries/ }).click()
  await expect(page.getByText('All payees triaged — hit Save.')).toBeVisible()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Transactions' }).click()
  await expect(page.locator('tr', { hasText: 'Farm Stand' }).locator('option').first())
    .toHaveText('Essentials → Groceries → Stores')
  await expect(page.locator('tr', { hasText: 'Coffee Cart' }).locator('option').first())
    .toHaveText('Essentials → Groceries')
})

test('categories tab arrows collapse and expand a subtree', async ({ page }) => {
  await launchApp(page, '/main/Categories')
  await expect(page.locator('[data-node-id="c-groceries"]')).toBeVisible()
  await page.locator('[data-node-id="g1"] span').first().click()
  await expect(page.locator('[data-node-id="c-groceries"]')).toHaveCount(0)
  // other groups are unaffected
  await expect(page.locator('[data-node-id="c-restaurants"]')).toBeVisible()
  await page.locator('[data-node-id="g1"] span').first().click()
  await expect(page.locator('[data-node-id="c-groceries"]')).toBeVisible()
})
