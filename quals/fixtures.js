// Fixture YNAB API responses. All quals run against these via request
// interception — no real token, no real network, no writes possible.

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const BUDGETS = { data: { budgets: [{ id: 'b1', name: 'Qual Budget' }] } }

export const CATEGORIES = { data: { category_groups: [
  { id: 'g1', name: 'Essentials', hidden: false, deleted: false, categories: [
    { id: 'c-groceries', name: 'Groceries', hidden: false, deleted: false },
    { id: 'c-rent', name: 'Rent', hidden: false, deleted: false },
  ]},
  { id: 'g2', name: 'Fun', hidden: false, deleted: false, categories: [
    { id: 'c-restaurants', name: 'Restaurants', hidden: false, deleted: false },
    { id: 'c-games', name: 'Games', hidden: false, deleted: false },
  ]},
  // mixes spending and income so the group nets negative when lumped
  { id: 'g3', name: 'Custom', hidden: false, deleted: false, categories: [
    { id: 'c-transfer', name: 'Transfer', hidden: false, deleted: false },
    { id: 'c-paycheck', name: 'Paycheck', hidden: false, deleted: false },
  ]},
]}}

// amounts are YNAB milliunits; negative = outflow
const tx = (id, days, payee, categoryId, amount, memo = '') => ({
  id, date: daysAgo(days), amount, memo,
  account_name: 'Checking', payee_name: payee, category_id: categoryId,
  deleted: false, subtransactions: [],
})

export const TRANSACTIONS = { data: { transactions: [
  tx('t1',  5,  'Corner Grocer',   'c-groceries',   -25000),
  tx('t2',  12, 'Corner Grocer',   'c-groceries',   -40000),
  tx('t3',  20, 'Farm Stand',      'c-groceries',   -15000),
  tx('t4',  30, 'Coffee Cart',     'c-groceries',   -8000),
  tx('t5',  10, 'Landlord LLC',    'c-rent',       -900000),
  tx('t6',  40, 'Landlord LLC',    'c-rent',       -900000),
  tx('t7',  8,  'Noodle House',    'c-restaurants', -32000),
  tx('t8',  25, 'Noodle House',    'c-restaurants', -28000),
  tx('t9',  15, 'Game Shop',       'c-games',       -60000),
  tx('t10', 7,  'CC Payment',      'c-transfer',   -100000),
  tx('t11', 9,  'Employer Inc',    'c-paycheck',    500000),
  // outside the default one-year window; only visible after widening the range
  tx('t-old', 400, 'Ancient Payee', 'c-games',      -10000),
]}}

// Seeds the token + budget so the app loads straight into fixture data.
export async function launchApp(page, path = '/') {
  await page.route('https://api.ynab.com/v1/budgets', r => r.fulfill({ json: BUDGETS }))
  await page.route('https://api.ynab.com/v1/budgets/b1/transactions**', r => r.fulfill({ json: TRANSACTIONS }))
  await page.route('https://api.ynab.com/v1/budgets/b1/categories', r => r.fulfill({ json: CATEGORIES }))
  await page.addInitScript(() => {
    localStorage.setItem('ynab_token', 'qual-token')
    localStorage.setItem('ynab_budget_id', 'b1')
  })
  await page.goto(path)
}

// Creates a scenario (ops are enabled off-main) and returns after it's active.
// Targets the scenario dropdown by its unique "＋ New scenario…" option — a bare
// nth(1) races with the category dropdowns some tabs render.
export async function createScenario(page, name) {
  await page.locator('select:has(option[value="__new__"])').selectOption('__new__')
  await page.getByPlaceholder('Scenario name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
}
