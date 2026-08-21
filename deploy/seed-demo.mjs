/**
 * Fills the demo household (deploy/compose.demo.yml) with sample data.
 *
 *   HEORTH_URL=http://localhost:4100 KITH_URL=http://localhost:4102 \
 *   HEORTH_ADMIN_EMAIL=... HEORTH_ADMIN_PASSWORD=... KITH_ADMIN_PASSWORD=... \
 *   DEMO_MEMBER_PASSWORD=... node deploy/seed-demo.mjs
 *
 * Normally invoked by deploy/demo-up.sh, which exports all of the above.
 *
 * IDEMPOTENT. Every create is preceded by a lookup on a natural key (a
 * member's email, a recipe title, an account name, a person's name...), so
 * re-running adds nothing and repairs anything missing. It never deletes.
 *
 * ONLY EVER POINT THIS AT THE DEMO STACK. It writes household data as real
 * members; there is nothing here that distinguishes a demo Heorth from a real
 * one but the URL you give it.
 *
 * WHY THE SEED LOGS IN TWICE:
 * Heorth's admin is the MAINTENANCE admin (src/household/maintenance-admin.ts).
 * It is quarantined from owning household data — calendar, meals, library,
 * tasks and finance all call assertNotMaintenanceAdmin on the acting member —
 * and boot strips any it accumulated. So the admin is used for exactly what
 * only it can do (creating members, patching the household) and every content
 * write is done as an ordinary member.
 */

const HEORTH = (process.env.HEORTH_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const KITH = (process.env.KITH_URL ?? 'http://localhost:4102').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.HEORTH_ADMIN_EMAIL ?? 'admin@demo.invalid';
const ADMIN_PASSWORD = req('HEORTH_ADMIN_PASSWORD');
const KITH_ADMIN_PASSWORD = req('KITH_ADMIN_PASSWORD');
const MEMBER_PASSWORD = process.env.DEMO_MEMBER_PASSWORD ?? 'demo-member-pw';

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`seed: ${name} is required`);
    process.exit(2);
  }
  return v;
}

/* ---------------------------------------------------------------- transport */

async function call(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const e = new Error(
      `${method} ${path} -> ${res.status} ${parsed?.error?.code ?? ''} ${parsed?.error?.message ?? text}`.trim()
    );
    e.status = res.status;
    e.payload = parsed;
    throw e;
  }
  // Every service wraps success as { data, meta } (wyrhta-core/src/http/response.ts).
  return parsed.data;
}

const heorth = (m, p, o) => call(HEORTH, m, p, o);
const kith = (m, p, o) => call(KITH, m, p, o);

/* ------------------------------------------------------------------ helpers */

/** Create only if `find` turns up nothing. Returns [record, 'created'|'existing']. */
async function ensure(label, find, create) {
  const found = await find();
  if (found) return [found, 'existing'];
  try {
    return [await create(), 'created'];
  } catch (e) {
    // Lost a race, or a unique constraint we did not model — re-read.
    if (e.status === 409) {
      const again = await find();
      if (again) return [again, 'existing'];
    }
    throw new Error(`seeding ${label} failed: ${e.message}`);
  }
}

const tally = {};
function count(kind, verdict) {
  tally[kind] ??= { created: 0, existing: 0 };
  tally[kind][verdict]++;
}

/* -------------------------------------------------------------------- dates */

/**
 * Dates are anchored to the Monday of the current week, so a freshly seeded
 * demo always has a calendar and meal plan around "now" rather than a fixed
 * past week. Hardcoded dates would make the demo look abandoned within days.
 */
const monday = (() => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  // getUTCDay(): 0=Sun. Shift back to Monday.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
})();

/** ISO date (YYYY-MM-DD) `n` days from that Monday. */
function day(n) {
  const d = new Date(monday);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Full ISO timestamp `n` days from that Monday, at HH:MM UTC. */
function at(n, hh, mm = 0) {
  const d = new Date(monday);
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

/* ------------------------------------------------------------------ heorth */

const MEMBERS = [
  { key: 'rowan', email: 'rowan@demo.invalid', displayName: 'Rowan Ash', avatarColor: 'ember', role: 'adult' },
  { key: 'mira', email: 'mira@demo.invalid', displayName: 'Mira Ash', avatarColor: 'sage', role: 'adult' },
  { key: 'wren', email: 'wren@demo.invalid', displayName: 'Wren Ash', avatarColor: 'sky', role: 'child' },
  { key: 'tobin', email: 'tobin@demo.invalid', displayName: 'Tobin Ash', avatarColor: 'taupe', role: 'child' },
];

async function seedHeorth() {
  console.log(`\n--- Heorth (${HEORTH}) ---`);

  const { token: adminToken } = await heorth('POST', '/api/v1/auth/token', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  console.log('logged in as the maintenance admin');

  // Household name/timezone/locale. timezone and locale are pick-from-list,
  // validated against GET /household/options.
  await heorth('PATCH', '/api/v1/household', {
    token: adminToken,
    body: { name: 'Ashcombe Demo Household', timezone: 'Europe/Berlin', locale: 'de-DE' },
  });
  console.log('household settings applied');

  // --- members (admin-only) ------------------------------------------------
  const existing = await heorth('GET', '/api/v1/members', { token: adminToken });
  const byEmail = new Map((existing ?? []).map((m) => [m.email, m]));
  const member = {};

  for (const m of MEMBERS) {
    const [rec, verdict] = await ensure(
      `member ${m.email}`,
      async () => byEmail.get(m.email) ?? null,
      async () =>
        heorth('POST', '/api/v1/members', {
          token: adminToken,
          body: {
            email: m.email,
            password: MEMBER_PASSWORD,
            displayName: m.displayName,
            avatarColor: m.avatarColor,
            role: m.role,
          },
        })
    );
    member[m.key] = rec;
    count('members', verdict);
  }
  console.log(`members: ${MEMBERS.map((m) => m.displayName).join(', ')}`);

  // --- switch identity: content is owned by a member, never by the admin ---
  const { token } = await heorth('POST', '/api/v1/auth/token', {
    body: { email: MEMBERS[0].email, password: MEMBER_PASSWORD },
  });
  const as = { token };
  console.log(`writing household content as ${MEMBERS[0].displayName}`);

  // --- calendar ------------------------------------------------------------
  // `recurrence` is an ISO 8601 DURATION (P1W, P1M, P1Y), not an RRULE — see
  // Heorth's src/lib/duration.ts. The create schema accepts any string, but an
  // unparseable one makes the range view (GET /events?from&to) throw on every
  // request from then on, so getting this wrong poisons the calendar.
  const events = [
    { title: 'Bin day', startAt: at(1, 7), endAt: at(1, 7, 30), category: 'chores', recurrence: 'P1W', attendees: ['rowan'] },
    { title: 'Wren — swimming', startAt: at(2, 16), endAt: at(2, 17), location: 'Ashcombe Baths', category: 'kids', recurrence: 'P1W', attendees: ['wren', 'mira'] },
    { title: 'Tobin — piano lesson', startAt: at(3, 15, 30), endAt: at(3, 16, 15), location: 'Ms. Halloran’s', category: 'kids', recurrence: 'P1W', attendees: ['tobin'] },
    { title: 'Rowan & Mira — date night', startAt: at(4, 19, 30), endAt: at(4, 22), category: 'social', recurrence: 'P1M', attendees: ['rowan', 'mira'] },
    { title: 'Family dinner with the Bellweathers', startAt: at(5, 18), endAt: at(5, 21), location: 'Home', category: 'social', attendees: ['rowan', 'mira', 'wren', 'tobin'] },
    { title: 'Boiler service', startAt: at(8, 9), endAt: at(8, 11), location: 'Home', notes: 'Annual service — engineer has the side-gate code.', category: 'home', attendees: ['rowan'] },
    { title: 'Mira — dentist', startAt: at(10, 11), endAt: at(10, 11, 45), category: 'health', attendees: ['mira'] },
    { title: 'School holidays begin', startAt: at(12, 0), endAt: at(12, 0), allDay: true, category: 'kids', attendees: ['wren', 'tobin'] },
  ];
  for (const e of events) {
    const [, verdict] = await ensure(
      `event ${e.title}`,
      async () => {
        const found = await heorth('GET', '/api/v1/events', { token });
        return (found ?? []).find((x) => x.title === e.title) ?? null;
      },
      async () =>
        heorth('POST', '/api/v1/events', {
          ...as,
          body: {
            title: e.title,
            startAt: e.startAt,
            endAt: e.endAt,
            allDay: e.allDay ?? false,
            location: e.location ?? null,
            notes: e.notes ?? null,
            category: e.category ?? null,
            recurrence: e.recurrence ?? null,
            attendeeIds: (e.attendees ?? []).map((k) => member[k].id),
          },
        })
    );
    count('events', verdict);
  }

  // --- recipes + meal plan + shopping list ---------------------------------
  const recipes = [
    {
      title: 'Sunday roast chicken',
      servings: 4,
      tags: ['sunday', 'roast'],
      ingredients: [
        { name: 'whole chicken', qty: 1, unit: 'ea' },
        { name: 'potatoes', qty: 1.2, unit: 'kg' },
        { name: 'carrots', qty: 500, unit: 'g' },
        { name: 'thyme', qty: 1, unit: 'bunch' },
      ],
      steps: ['Heat oven to 200C.', 'Roast chicken 1h20, basting twice.', 'Parboil then roast the potatoes.', 'Rest 15 minutes before carving.'],
    },
    {
      title: 'Lentil shepherd’s pie',
      servings: 6,
      tags: ['vegetarian', 'batch'],
      ingredients: [
        { name: 'green lentils', qty: 400, unit: 'g' },
        { name: 'potatoes', qty: 1, unit: 'kg' },
        { name: 'carrots', qty: 300, unit: 'g' },
        { name: 'tomato puree', qty: 2, unit: 'tbsp' },
      ],
      steps: ['Simmer lentils with the soffritto.', 'Mash the potatoes with butter.', 'Top and bake 30 minutes at 190C.'],
    },
    {
      title: 'Weeknight pasta e fagioli',
      servings: 4,
      tags: ['quick', 'vegetarian'],
      ingredients: [
        { name: 'borlotti beans', qty: 400, unit: 'g' },
        { name: 'ditalini', qty: 200, unit: 'g' },
        { name: 'rosemary', qty: 1, unit: 'sprig' },
        { name: 'parmesan', qty: 60, unit: 'g' },
      ],
      steps: ['Soften onion and rosemary.', 'Add beans and stock, simmer 15 min.', 'Cook the pasta in the soup.'],
    },
    {
      title: 'Fish pie',
      servings: 4,
      tags: ['fish'],
      ingredients: [
        { name: 'smoked haddock', qty: 400, unit: 'g' },
        { name: 'milk', qty: 500, unit: 'ml' },
        { name: 'potatoes', qty: 800, unit: 'g' },
        { name: 'peas', qty: 150, unit: 'g' },
      ],
      steps: ['Poach the fish in milk.', 'Make a bechamel from the poaching milk.', 'Top with mash and bake.'],
    },
    {
      title: 'Saturday pancakes',
      servings: 4,
      tags: ['breakfast', 'kids'],
      ingredients: [
        { name: 'plain flour', qty: 300, unit: 'g' },
        { name: 'milk', qty: 400, unit: 'ml' },
        { name: 'eggs', qty: 3, unit: 'ea' },
        { name: 'maple syrup', qty: 1, unit: 'bottle' },
      ],
      steps: ['Whisk to a smooth batter, rest 20 min.', 'Griddle in butter until golden.'],
    },
  ];

  const existingRecipes = (await heorth('GET', '/api/v1/recipes', { token })) ?? [];
  const recipeByTitle = new Map((existingRecipes.items ?? existingRecipes).map((r) => [r.title, r]));
  const recipeId = {};
  for (const r of recipes) {
    const [rec, verdict] = await ensure(
      `recipe ${r.title}`,
      async () => recipeByTitle.get(r.title) ?? null,
      async () => heorth('POST', '/api/v1/recipes', { ...as, body: r })
    );
    recipeId[r.title] = rec.id;
    count('recipes', verdict);
  }

  // Meal plan across this week. cook/helper must not be the maintenance admin.
  const plan = [
    { date: day(0), slot: 'supper', title: 'Weeknight pasta e fagioli', cook: 'rowan' },
    { date: day(1), slot: 'supper', title: 'Fish pie', cook: 'mira', helper: 'wren' },
    { date: day(2), slot: 'supper', freeText: 'Leftovers / fridge raid' },
    { date: day(3), slot: 'supper', title: 'Lentil shepherd’s pie', cook: 'rowan', helper: 'tobin' },
    { date: day(4), slot: 'supper', freeText: 'Takeaway night' },
    { date: day(5), slot: 'breakfast', title: 'Saturday pancakes', cook: 'mira', helper: 'wren' },
    { date: day(6), slot: 'lunch', title: 'Sunday roast chicken', cook: 'rowan', helper: 'mira' },
  ];
  const existingPlan = (await heorth('GET', `/api/v1/meals/plan?from=${day(0)}&to=${day(6)}`, { token })) ?? [];
  const planKeys = new Set((existingPlan.items ?? existingPlan).map((p) => `${p.date}|${p.slot}`));
  for (const p of plan) {
    const [, verdict] = await ensure(
      `meal ${p.date} ${p.slot}`,
      async () => (planKeys.has(`${p.date}|${p.slot}`) ? {} : null),
      async () =>
        heorth('POST', '/api/v1/meals/plan', {
          ...as,
          body: {
            date: p.date,
            slot: p.slot,
            recipeId: p.title ? recipeId[p.title] : null,
            freeText: p.freeText ?? null,
            cook: p.cook ? member[p.cook].id : null,
            helper: p.helper ? member[p.helper].id : null,
          },
        })
    );
    count('meal plan', verdict);
  }

  // Derive the shopping list from the plan, then add the things no recipe knows.
  await heorth('POST', `/api/v1/meals/shopping-list/generate?from=${day(0)}&to=${day(6)}`, { ...as, body: {} });
  const extras = [
    { name: 'washing-up liquid', qty: 1, unit: 'bottle' },
    { name: 'coffee beans', qty: 500, unit: 'g' },
    { name: 'lightbulb (E27)', qty: 2, unit: 'ea' },
  ];
  const existingShopping = (await heorth('GET', '/api/v1/meals/shopping-list', { token })) ?? [];
  const shoppingNames = new Set((existingShopping.items ?? existingShopping).map((i) => i.name));
  for (const x of extras) {
    const [, verdict] = await ensure(
      `shopping ${x.name}`,
      async () => (shoppingNames.has(x.name) ? {} : null),
      async () => heorth('POST', '/api/v1/meals/shopping-list', { ...as, body: x })
    );
    count('shopping list', verdict);
  }

  // --- inventory -----------------------------------------------------------
  const items = [
    { name: 'Vaillant ecoTEC boiler', category: 'heating', manufacturer: 'Vaillant', model: 'ecoTEC plus 832', serialNumber: 'VT-8832-114207', location: 'Utility room', purchaseDate: day(-980), purchasePrice: 2450, warrantyUntil: day(1850), notes: 'Serviced annually; filter changed at each service.' },
    { name: 'Bosch washing machine', category: 'appliance', manufacturer: 'Bosch', model: 'WAU28T64GB', serialNumber: 'BSH-2864-77213', location: 'Utility room', purchaseDate: day(-620), purchasePrice: 549, warrantyUntil: day(110) },
    { name: 'Miele dishwasher', category: 'appliance', manufacturer: 'Miele', model: 'G 5310 SC', location: 'Kitchen', purchaseDate: day(-410), purchasePrice: 799, warrantyUntil: day(320) },
    { name: 'Ford Focus estate', category: 'vehicle', manufacturer: 'Ford', model: 'Focus 1.5 EcoBlue', serialNumber: 'WF0-5K-2291884', location: 'Driveway', purchaseDate: day(-1420), purchasePrice: 11200, notes: 'MOT due each spring.' },
    { name: 'Bosch cordless drill', category: 'tool', manufacturer: 'Bosch', model: 'GSB 18V-55', location: 'Garage shelf', purchaseDate: day(-240), purchasePrice: 129 },
    { name: 'Honda lawnmower', category: 'garden', manufacturer: 'Honda', model: 'HRG 416', location: 'Shed', purchaseDate: day(-1100), purchasePrice: 389 },
    { name: 'Dell XPS 13 laptop', category: 'electronics', manufacturer: 'Dell', model: 'XPS 13 9310', serialNumber: 'DL-9310-4471', location: 'Study', purchaseDate: day(-830), purchasePrice: 1249, warrantyUntil: day(-100) },
    { name: 'Roberts kitchen radio', category: 'electronics', manufacturer: 'Roberts', model: 'Revival RD70', location: 'Kitchen', purchaseDate: day(-1500), purchasePrice: 165 },
  ];
  const existingItems = (await heorth('GET', '/api/v1/inventory/items?limit=100', { token })) ?? [];
  const itemByName = new Map((existingItems.items ?? existingItems).map((i) => [i.name, i]));
  const itemId = {};
  for (const it of items) {
    const [rec, verdict] = await ensure(
      `item ${it.name}`,
      async () => itemByName.get(it.name) ?? null,
      async () => heorth('POST', '/api/v1/inventory/items', { ...as, body: it })
    );
    itemId[it.name] = rec.id;
    count('inventory', verdict);
  }

  // One decommissioned item, so the lifecycle is visible in the demo and the
  // "active" filter has something to exclude.
  const oldTv = 'Panasonic plasma TV';
  const [tv, tvVerdict] = await ensure(
    `item ${oldTv}`,
    async () => itemByName.get(oldTv) ?? null,
    async () =>
      heorth('POST', '/api/v1/inventory/items', {
        ...as,
        body: { name: oldTv, category: 'electronics', manufacturer: 'Panasonic', model: 'TX-P42', location: 'Gone', purchaseDate: day(-2600), purchasePrice: 699 },
      })
  );
  count('inventory', tvVerdict);
  if (tvVerdict === 'created') {
    await heorth('POST', `/api/v1/inventory/items/${tv.id}/decommission`, {
      ...as,
      body: { date: day(-45), reason: 'sold', proceeds: 60 },
    });
  }

  // --- finance (Feoh, ADR 0007 — always on) --------------------------------
  const accounts = [
    { name: 'Joint current account', kind: 'asset', openingBalance: 4200 },
    { name: 'Savings — house fund', kind: 'asset', openingBalance: 15800 },
    { name: 'Cash', kind: 'asset', openingBalance: 120 },
    { name: 'Credit card', kind: 'liability', openingBalance: 640 },
    { name: 'Mortgage', kind: 'liability', openingBalance: 184000 },
  ];
  const existingAccounts = (await heorth('GET', '/api/v1/feoh/accounts', { token })) ?? [];
  const accByName = new Map(existingAccounts.map((a) => [a.name, a]));
  const accId = {};
  for (const a of accounts) {
    const [rec, verdict] = await ensure(
      `account ${a.name}`,
      async () => accByName.get(a.name) ?? null,
      async () => heorth('POST', '/api/v1/feoh/accounts', { ...as, body: a })
    );
    accId[a.name] = rec.id;
    count('accounts', verdict);
  }

  const envelopes = [
    { name: 'Groceries', monthlyBudget: 650, tone: 'sage' },
    { name: 'Utilities', monthlyBudget: 320, tone: 'ember' },
    { name: 'Transport', monthlyBudget: 180 },
    { name: 'Kids & school', monthlyBudget: 200, tone: 'sky' },
    { name: 'Home maintenance', monthlyBudget: 150, tone: 'taupe' },
    { name: 'Eating out', monthlyBudget: 120 },
    { name: 'Subscriptions', monthlyBudget: 60 },
    // Income is an envelope too: it is the budget side that salary
    // credits, so a transaction's postings still balance without a
    // real spending envelope absorbing the pay.
    { name: 'Income', monthlyBudget: 0 },
  ];
  const existingEnvelopes = (await heorth('GET', '/api/v1/feoh/envelopes', { token })) ?? [];
  const envByName = new Map(existingEnvelopes.map((e) => [e.name, e]));
  const envId = {};
  for (const e of envelopes) {
    const [rec, verdict] = await ensure(
      `envelope ${e.name}`,
      async () => envByName.get(e.name) ?? null,
      async () => heorth('POST', '/api/v1/feoh/envelopes', { ...as, body: e })
    );
    envId[e.name] = rec.id;
    count('envelopes', verdict);
  }

  // Double-entry: every transaction debits an envelope and credits an account
  // (or the reverse for income), so postings always balance.
  const spend = (date, payee, amount, envelope, account, memo) => ({
    date,
    payee,
    amount,
    memo: memo ?? null,
    postings: [
      { envelopeId: envId[envelope], debit: amount, credit: 0 },
      { accountId: accId[account], debit: 0, credit: amount },
    ],
  });

  const txns = [
    spend(day(-26), 'Ashcombe Farm Shop', 78.4, 'Groceries', 'Joint current account'),
    spend(day(-24), 'Northern Gas', 142.0, 'Utilities', 'Joint current account', 'Monthly direct debit'),
    spend(day(-22), 'Shell', 61.2, 'Transport', 'Credit card'),
    spend(day(-20), 'Ashcombe Primary', 45.0, 'Kids & school', 'Joint current account', 'Trip to the aquarium'),
    spend(day(-18), 'Screwfix', 33.75, 'Home maintenance', 'Credit card', 'Sealant and brushes'),
    spend(day(-16), 'Sainsbury’s', 96.15, 'Groceries', 'Joint current account'),
    spend(day(-14), 'The Fleece', 54.0, 'Eating out', 'Credit card', 'Anniversary'),
    spend(day(-12), 'Netflix', 12.99, 'Subscriptions', 'Credit card'),
    spend(day(-10), 'Ashcombe Water', 38.5, 'Utilities', 'Joint current account'),
    spend(day(-8), 'Sainsbury’s', 104.3, 'Groceries', 'Joint current account'),
    spend(day(-6), 'Halfords', 89.99, 'Transport', 'Joint current account', 'New wiper blades and a bulb kit'),
    spend(day(-4), 'Ashcombe Baths', 42.0, 'Kids & school', 'Joint current account', 'Wren — swimming term'),
    spend(day(-2), 'Co-op', 27.85, 'Groceries', 'Cash'),
    spend(day(-1), 'Spotify', 17.99, 'Subscriptions', 'Credit card', 'Family plan'),
  ];

  // Salary: money into an account, credited from the household's own budget
  // side. Split between the two adults so the splits surface has data.
  const salary = {
    date: day(-25),
    payee: 'Ashcombe Joinery Ltd (salary)',
    amount: 3850,
    memo: 'Monthly net pay',
    postings: [
      { accountId: accId['Joint current account'], debit: 3850, credit: 0 },
      { envelopeId: envId['Income'], debit: 0, credit: 3850 },
    ],
    // `share` is numeric(14,2) — a money amount, not a fraction. The shares
    // sum to the transaction total.
    splits: [
      { memberId: member.rowan.id, share: 2310 },
      { memberId: member.mira.id, share: 1540 },
    ],
  };

  const existingTxns = (await heorth('GET', '/api/v1/feoh/transactions?limit=100', { token })) ?? [];
  const txnKeys = new Set((existingTxns.items ?? existingTxns).map((t) => `${t.date}|${t.payee}`));
  for (const t of [salary, ...txns]) {
    const [, verdict] = await ensure(
      `transaction ${t.date} ${t.payee}`,
      async () => (txnKeys.has(`${t.date}|${t.payee}`) ? {} : null),
      async () => heorth('POST', '/api/v1/feoh/transactions', { ...as, body: t })
    );
    count('transactions', verdict);
  }

  // Recurring bills, one of them tied to an inventory item so the item-cost
  // link has something real behind it.
  const bills = [
    { payee: 'Northern Gas', amount: 142.0, cadence: 'monthly', nextDue: day(6), envelope: 'Utilities' },
    { payee: 'Ashcombe Water', amount: 38.5, cadence: 'monthly', nextDue: day(10), envelope: 'Utilities' },
    { payee: 'Council tax', amount: 187.0, cadence: 'monthly', nextDue: day(9), envelope: 'Utilities' },
    { payee: 'Netflix', amount: 12.99, cadence: 'monthly', nextDue: day(18), envelope: 'Subscriptions' },
    { payee: 'Spotify', amount: 17.99, cadence: 'monthly', nextDue: day(29), envelope: 'Subscriptions' },
    { payee: 'Boiler service plan', amount: 168.0, cadence: 'yearly', nextDue: day(40), envelope: 'Home maintenance', item: 'Vaillant ecoTEC boiler' },
    { payee: 'Car insurance', amount: 412.0, cadence: 'yearly', nextDue: day(75), envelope: 'Transport', item: 'Ford Focus estate' },
    { payee: 'Window cleaner', amount: 18.0, cadence: 'quarterly', nextDue: day(21), envelope: 'Home maintenance' },
  ];
  const existingBills = (await heorth('GET', '/api/v1/feoh/bills', { token })) ?? [];
  const billByPayee = new Map(existingBills.map((b) => [b.payee, b]));
  for (const b of bills) {
    const [, verdict] = await ensure(
      `bill ${b.payee}`,
      async () => billByPayee.get(b.payee) ?? null,
      async () =>
        heorth('POST', '/api/v1/feoh/bills', {
          ...as,
          body: {
            payee: b.payee,
            amount: b.amount,
            cadence: b.cadence,
            nextDue: b.nextDue,
            envelopeId: envId[b.envelope] ?? null,
            inventoryItemId: b.item ? (itemId[b.item] ?? null) : null,
          },
        })
    );
    count('bills', verdict);
  }

  return { adminToken, memberToken: token, member };
}

/* -------------------------------------------------------------- kithledger */

const PEOPLE = [
  { key: 'nadia', name: 'Nadia Bellweather', email: 'nadia.bellweather@demo.invalid', phone: '+44 7700 900112', birthday: '1984-03-14', tags: ['friend', 'neighbour'], notes: 'Two doors down. Has our spare key.' },
  { key: 'colin', name: 'Colin Bellweather', email: 'colin.bellweather@demo.invalid', birthday: '1982-11-02', tags: ['friend', 'neighbour'], notes: 'Runs the allotment association.' },
  { key: 'harriet', name: 'Harriet Vane', email: 'harriet.vane@demo.invalid', phone: '+44 7700 900318', birthday: '1979-07-22', tags: ['friend'], notes: 'University friend. Lives in Leeds now.' },
  { key: 'sam', name: 'Sam Okonjo', email: 's.okonjo@demo.invalid', birthday: '1988-01-09', tags: ['colleague'], notes: 'Works with Rowan at the joinery.' },
  { key: 'iris', name: 'Iris Ash', phone: '+44 7700 900455', birthday: '1951-05-30', tags: ['family'], notes: 'Rowan’s mother. Prefers a phone call to a message.' },
  { key: 'gerald', name: 'Gerald Ash', birthday: '1949-09-17', tags: ['family'], notes: 'Rowan’s father.' },
  { key: 'priya', name: 'Priya Raman', email: 'priya.raman@demo.invalid', birthday: '1986-12-05', tags: ['friend', 'school-gate'], notes: 'Her daughter is in Wren’s class.' },
  { key: 'ms-halloran', name: 'Eileen Halloran', phone: '+44 7700 900677', tags: ['service'], notes: 'Tobin’s piano teacher. Thursdays.' },
  { key: 'dev', name: 'Dev Chaudhry', email: 'dev@demo.invalid', tags: ['service'], notes: 'Gas engineer — services the boiler.' },
];

async function seedKith() {
  console.log(`\n--- KithLedger (${KITH}) ---`);

  const { token } = await kith('POST', '/api/v1/auth/token', {
    body: { email: 'admin@kithledger.local', password: KITH_ADMIN_PASSWORD },
  });
  const as = { token };
  console.log('logged in as the KithLedger admin');

  const existing = (await kith('GET', '/api/v1/people?limit=100', { token })) ?? [];
  const byName = new Map((existing.items ?? existing).map((p) => [p.name, p]));
  const person = {};

  for (const p of PEOPLE) {
    const [rec, verdict] = await ensure(
      `person ${p.name}`,
      async () => byName.get(p.name) ?? null,
      async () =>
        kith('POST', '/api/v1/people', {
          ...as,
          body: {
            name: p.name,
            email: p.email ?? null,
            phone: p.phone ?? null,
            birthday: p.birthday ?? null,
            tags: p.tags ?? [],
            notes: p.notes ?? null,
          },
        })
    );
    person[p.key] = rec;
    count('people', verdict);
  }
  console.log(`people: ${PEOPLE.length}`);

  // --- relationships between them -----------------------------------------
  const rels = [
    { from: 'nadia', to: 'colin', type: 'family', label: 'married to' },
    { from: 'iris', to: 'gerald', type: 'family', label: 'married to' },
    { from: 'nadia', to: 'priya', type: 'friend', label: 'school-gate friends' },
    { from: 'harriet', to: 'sam', type: 'acquaintance', label: 'met at our barbecue' },
    { from: 'colin', to: 'dev', type: 'acquaintance', label: 'recommended him to us' },
  ];
  const existingRels = (await kith('GET', '/api/v1/relationships?limit=100', { token })) ?? [];
  const relKeys = new Set(
    (existingRels.items ?? existingRels).map((r) => `${r.fromPersonId}|${r.toPersonId}`)
  );
  for (const r of rels) {
    const key = `${person[r.from].id}|${person[r.to].id}`;
    const [, verdict] = await ensure(
      `relationship ${r.from}->${r.to}`,
      async () => (relKeys.has(key) ? {} : null),
      async () =>
        kith('POST', '/api/v1/relationships', {
          ...as,
          body: {
            fromPersonId: person[r.from].id,
            toPersonId: person[r.to].id,
            type: r.type,
            label: r.label,
            isMutual: true,
          },
        })
    );
    count('relationships', verdict);
  }

  // --- interaction history -------------------------------------------------
  const interactions = [
    { who: 'nadia', at: at(-9, 19), type: 'meeting', channel: 'in-person', sentiment: 'positive', notes: 'Dropped round with plums from their tree.' },
    { who: 'iris', at: at(-8, 18, 30), type: 'call', channel: 'phone', sentiment: 'positive', notes: 'Sunday call. Her knee is better.' },
    { who: 'harriet', at: at(-7, 21), type: 'message', channel: 'sms', sentiment: 'neutral', notes: 'Swapping dates for a visit — nothing fixed yet.' },
    { who: 'sam', at: at(-5, 12, 15), type: 'meeting', channel: 'in-person', sentiment: 'neutral', notes: 'Lunch at work. He is moving house in the autumn.' },
    { who: 'priya', at: at(-4, 8, 45), type: 'meeting', channel: 'in-person', sentiment: 'positive', notes: 'School gate. Offered to take Wren to swimming next week.' },
    { who: 'dev', at: at(-3, 10), type: 'call', channel: 'phone', sentiment: 'neutral', notes: 'Booked the boiler service.' },
    { who: 'colin', at: at(-2, 17), type: 'message', channel: 'social', sentiment: 'positive', notes: 'Allotment committee photos.' },
    { who: 'iris', at: at(-1, 18, 30), type: 'call', channel: 'phone', sentiment: 'positive', notes: 'Sunday call.' },
    { who: 'ms-halloran', at: at(-1, 16), type: 'email', channel: 'email', sentiment: 'neutral', notes: 'Tobin’s lesson moved to 15:30 from now on.' },
    { who: 'gerald', at: at(-15, 14), type: 'meeting', channel: 'in-person', sentiment: 'positive', notes: 'Drove over for the afternoon.' },
  ];
  const existingInts = (await kith('GET', '/api/v1/interactions?limit=100', { token })) ?? [];
  const intKeys = new Set(
    (existingInts.items ?? existingInts).map((i) => `${i.personId}|${i.occurredAt}`)
  );
  for (const i of interactions) {
    const key = `${person[i.who].id}|${i.at}`;
    const [, verdict] = await ensure(
      `interaction ${i.who} ${i.at}`,
      async () => (intKeys.has(key) ? {} : null),
      async () =>
        kith('POST', '/api/v1/interactions', {
          ...as,
          body: {
            personId: person[i.who].id,
            occurredAt: i.at,
            type: i.type,
            channel: i.channel,
            notes: i.notes,
            sentiment: i.sentiment,
          },
        })
    );
    count('interactions', verdict);
  }

  // --- reminders -----------------------------------------------------------
  const reminders = [
    { who: 'iris', dueAt: at(6, 18, 30), title: 'Sunday call with Mum', recurrence: 'P7D' },
    { who: 'harriet', dueAt: at(4, 9), title: 'Pin down a date for Harriet’s visit' },
    { who: 'nadia', dueAt: at(2, 12), title: 'Return the Bellweathers’ cake tin' },
    { who: 'sam', dueAt: at(14, 9), title: 'Ask Sam how the move went' },
    { who: 'priya', dueAt: at(1, 8), title: 'Thank Priya for the swimming lift' },
    { who: 'iris', dueAt: at(30, 9), title: 'Iris — birthday', kind: 'birthday', leadDays: 7 },
    { who: 'nadia', dueAt: at(45, 9), title: 'Nadia — birthday', kind: 'birthday', leadDays: 3 },
  ];
  const existingRems = (await kith('GET', '/api/v1/reminders?limit=100', { token })) ?? [];
  const remTitles = new Set((existingRems.items ?? existingRems).map((r) => r.title));
  for (const r of reminders) {
    const [, verdict] = await ensure(
      `reminder ${r.title}`,
      async () => (remTitles.has(r.title) ? {} : null),
      async () =>
        kith('POST', '/api/v1/reminders', {
          ...as,
          body: {
            personId: person[r.who].id,
            dueAt: r.dueAt,
            title: r.title,
            recurrence: r.recurrence ?? null,
            kind: r.kind ?? 'generic',
            leadDays: r.leadDays ?? null,
          },
        })
    );
    count('reminders', verdict);
  }
}

/* --------------------------------------------------------------------- main */

async function main() {
  await seedHeorth();
  await seedKith();

  console.log('\n--- seeded ---');
  const width = Math.max(...Object.keys(tally).map((k) => k.length));
  for (const [kind, n] of Object.entries(tally)) {
    console.log(`  ${kind.padEnd(width)}  ${String(n.created).padStart(3)} created, ${n.existing} already there`);
  }
  console.log(`\nMembers all share the password: ${MEMBER_PASSWORD}`);
  for (const m of MEMBERS) console.log(`  ${m.email.padEnd(22)} ${m.role}`);
}

main().catch((e) => {
  console.error(`\nseed failed: ${e.message}`);
  if (e.payload) console.error(JSON.stringify(e.payload, null, 2));
  process.exit(1);
});
