import { test, expect } from '@playwright/test'
import { launchApp, createScenario } from './fixtures.js'

const label = (page, name) => page.locator(`[data-label-for="${name}"]`)

test('transactions tab renders fixture rows', async ({ page }) => {
  await launchApp(page)
  await expect(page.getByText('Landlord LLC').first()).toBeVisible()
  await expect(page.getByText('Noodle House').first()).toBeVisible()
  // outside the default one-year date range
  await expect(page.getByText('Ancient Payee')).toHaveCount(0)
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
  await expect(label(page, 'Essentials').getByRole('button', { name: 'split' })).toBeVisible()
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
  await firstSelect.selectOption({ label: 'Games' })
  await expect(firstSelect.locator('option:checked')).toHaveText('Games')
  await page.reload()
  await expect(page.locator('tbody select').first().locator('option:checked')).toHaveText('Games')
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

test('split editor saves a split and the new category appears', async ({ page }) => {
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
  await expect(page.locator('svg text', { hasText: /^Coffee$/ })).toBeVisible()
  // the scenario-local category shows up in the transactions dropdown
  await page.getByRole('button', { name: 'Transactions' }).click()
  await expect(page.locator('tbody select').first().locator('option', { hasText: /^Coffee$/ })).toHaveCount(1)
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
  await bar.getByRole('button', { name: 'split' }).click()
  await expect(page.locator('svg text', { hasText: /^Transfer$/ })).toBeVisible()
})

test('zoom shows categories, payee split narrows the detail panel', async ({ page }) => {
  await launchApp(page, '/main/Reports')
  await label(page, 'Essentials').getByRole('button', { name: 'zoom' }).click()
  await expect(label(page, 'Groceries')).toBeVisible()
  await expect(label(page, 'Rent')).toBeVisible()
  await label(page, 'Groceries').getByRole('button', { name: 'split' }).click()
  const payeeBox = page.locator('svg text', { hasText: /^Corner/ }).first()
  await expect(payeeBox).toBeVisible()
  await payeeBox.click({ force: true })
  await expect(page.getByText('· Corner Grocer')).toBeVisible()
})
