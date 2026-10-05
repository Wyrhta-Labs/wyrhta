/**
 * Bulk sample data for the DEV stack, on top of deploy/seed-dev.mjs.
 *
 *   node deploy/seed-dev.mjs && node deploy/seed-dev-bulk.mjs
 *
 * Requires seed-dev.mjs to have run first (members, accounts, envelopes,
 * places). Reads deploy/.env itself; values already in the environment win.
 *
 * Adds roughly: ~270 events over -180..+90 days, 30 recipes, 15 weeks of meal
 * plan, 15 places, 45 assets, 17 Weorc routines, ~160 transactions over six
 * months, 18 bills, 40 import-inbox lines; in KithLedger 40 people, ~35
 * relationships, 320 interactions, ~55 reminders.
 *
 * DETERMINISTIC (fixed PRNG seed, fixed ANCHOR date) and IDEMPOTENT on natural
 * keys, so a re-run adds nothing. ANCHOR is fixed on purpose: anchoring to
 * "now" would add a shifted copy of six months of history on every later run.
 * Per-item failures are tallied and reported instead of aborting the run.
 * Heorth rate-limits logins; back-to-back runs can hit 429 — wait and retry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('./.env', import.meta.url));
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!m || process.env[m[1]] !== undefined) continue;
  process.env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
}

const HEORTH = (process.env.HEORTH_URL ?? 'http://localhost:14000').replace(/\/$/, '');
const KITH = (process.env.KITH_URL ?? 'http://localhost:14002').replace(/\/$/, '');
const PW = process.env.DEMO_MEMBER_PASSWORD ?? 'demo-member-pw';
const KITH_ADMIN_PASSWORD = process.env.KITH_ADMIN_PASSWORD;

const ANCHOR = new Date('2026-09-28T00:00:00Z'); // a Monday
const day = (n) => { const d = new Date(ANCHOR); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (n, hh, mm = 0) => { const d = new Date(ANCHOR); d.setUTCDate(d.getUTCDate() + n); d.setUTCHours(hh, mm, 0, 0); return d.toISOString(); };
const dow = (n) => { const d = new Date(ANCHOR); d.setUTCDate(d.getUTCDate() + n); return d.getUTCDay(); };

let s = 0x5eed1234;
/** Restart the PRNG from a per-section seed, so each section generates the same rows on every run. */
const reseed = (label) => { s = 0x5eed1234; for (const ch of label) s = (Math.imul(s, 31) + ch.charCodeAt(0)) | 0; };
const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);
const money = (lo, hi) => Math.round(between(lo, hi) * 100) / 100;
const int = (lo, hi) => Math.floor(between(lo, hi + 1));

async function call(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let p; try { p = text ? JSON.parse(text) : {}; } catch { p = { raw: text }; }
  if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status} ${p?.error?.code ?? ''} ${p?.error?.message ?? text}`.trim()); e.status = res.status; throw e; }
  return p;
}
const H = (m, p, o) => call(HEORTH, m, p, o).then((r) => r.data);
const K = (m, p, o) => call(KITH, m, p, o).then((r) => r.data);

/** Page a limit/offset listing to the end. */
async function all(base, path, token) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += 100) {
    const r = await call(base, 'GET', `${path}${sep}limit=100&offset=${offset}`, { token });
    const rows = r.data?.items ?? r.data ?? [];
    out.push(...rows);
    if (rows.length < 100 || (r.meta?.total != null && out.length >= r.meta.total)) break;
  }
  return out;
}

const tally = {};
const failures = [];
async function make(kind, exists, create) {
  tally[kind] ??= { created: 0, existing: 0, failed: 0 };
  if (exists) { tally[kind].existing++; return null; }
  try { const r = await create(); tally[kind].created++; return r; }
  catch (e) { tally[kind].failed++; if (failures.length < 25) failures.push(`${kind}: ${e.message}`); return null; }
}

/* ======================================================================= */

async function heorthBulk() {
  const login = async (email) => (await H('POST', '/api/v1/auth/token', { body: { email, password: PW } })).token;
  const rowan = await login('rowan@demo.invalid');
  const mira = await login('mira@demo.invalid');
  const as = (t) => ({ token: t });
  // Alternate writers by counter, never by rnd(): draws inside a create would
  // only happen on a create, so a re-run would shift every later draw.
  let writes = 0;
  const tok = () => (writes++ % 2 ? mira : rowan);

  const members = await H('GET', '/api/v1/household/members', { token: rowan }).catch(() => null)
    ?? await H('GET', '/api/v1/members', { token: rowan }).catch(() => []);
  const mem = Object.fromEntries((members ?? []).filter((m) => m.email?.endsWith('@demo.invalid')).map((m) => [m.email.split('@')[0], m.id]));
  if (!mem.rowan) throw new Error('demo members not visible — run deploy/seed-demo.mjs first');
  const adults = ['rowan', 'mira'], kids = ['wren', 'tobin'], everyone = [...adults, ...kids];

  /* ---- calendar: ~200 events over -180..+90 days ---- */
  const existingEvents = await all(HEORTH, '/api/v1/events', rowan);
  const evKeys = new Set(existingEvents.map((e) => `${e.title}|${new Date(e.startAt).toISOString()}`));
  const evTemplates = [
    { t: 'Football training — Tobin', cat: 'kids', who: ['tobin'], h: 17, dur: 90, loc: 'Ashcombe Rec Ground', days: [2] },
    { t: 'Brownies — Wren', cat: 'kids', who: ['wren'], h: 18, dur: 75, loc: 'Scout hut', days: [4] },
    { t: 'Big shop', cat: 'chores', who: ['rowan'], h: 10, dur: 90, loc: 'Sainsbury’s', days: [6] },
    { t: 'Yoga', cat: 'health', who: ['mira'], h: 19, dur: 60, loc: 'Studio Nine', days: [1] },
    { t: 'Parkrun', cat: 'health', who: ['rowan', 'wren'], h: 9, dur: 60, loc: 'Ashcombe Park', days: [6] },
  ];
  const oneOffs = [
    ['GP appointment', 'health'], ['Parents’ evening', 'kids'], ['Car MOT', 'home'], ['Haircut', 'personal'], ['Birthday party', 'social'],
    ['Dinner with friends', 'social'], ['Plumber visit', 'home'], ['School play rehearsal', 'kids'], ['Optician', 'health'], ['Council recycling collection', 'chores'],
    ['Book club', 'social'], ['Vet — booster jabs', 'home'], ['Allotment working party', 'social'], ['Dentist check-up', 'health'], ['School trip', 'kids'],
    ['Visit Grandma Iris', 'family'], ['Bike repair drop-off', 'chores'], ['Quiz night at The Fleece', 'social'], ['Window cleaner', 'home'], ['Car service', 'home'],
  ];
  // No reseed here: events are the first draws after start-up, so they match
  // the rows the first ever run wrote.
  const evs = [];
  for (let n = -180; n <= 90; n++) {
    for (const tpl of evTemplates) if (tpl.days.includes(dow(n)) && rnd() < 0.85) evs.push({ title: tpl.t, startAt: at(n, tpl.h), endAt: new Date(Date.parse(at(n, tpl.h)) + tpl.dur * 60000).toISOString(), location: tpl.loc, category: tpl.cat, who: tpl.who });
    if (rnd() < 0.35) {
      const [t, cat] = pick(oneOffs);
      const h = int(8, 19), who = cat === 'kids' ? [pick(kids), pick(adults)] : cat === 'social' || cat === 'family' ? everyone : [pick(adults)];
      evs.push({ title: t, startAt: at(n, h), endAt: at(n, h + 1), category: cat, who: [...new Set(who)], notes: rnd() < 0.3 ? 'Booked online — confirmation in email.' : null });
    }
  }
  evs.push({ title: 'Summer holiday — Cornwall', startAt: at(-90, 0), endAt: at(-80, 0), allDay: true, category: 'family', who: everyone, location: 'St Ives' });
  evs.push({ title: 'Christmas at Iris & Gerald’s', startAt: at(88, 0), endAt: at(89, 0), allDay: true, category: 'family', who: everyone });
  evs.push({ title: 'Half-term', startAt: at(26, 0), endAt: at(30, 0), allDay: true, category: 'kids', who: kids });
  for (const e of evs) {
    await make('events', evKeys.has(`${e.title}|${new Date(e.startAt).toISOString()}`), () =>
      H('POST', '/api/v1/events', { ...as(tok()), body: { title: e.title, startAt: e.startAt, endAt: e.endAt, allDay: e.allDay ?? false, location: e.location ?? null, notes: e.notes ?? null, category: e.category, recurrence: null, attendeeIds: e.who.map((k) => mem[k]) } }));
  }

  /* ---- recipes: +30 ---- */
  const R = (title, servings, tags, ing, steps) => ({ title, servings, tags, ingredients: ing.map(([name, qty, unit]) => ({ name, qty, unit })), steps });
  const recipes = [
    R('Chicken tikka masala', 4, ['curry'], [['chicken thighs', 600, 'g'], ['yoghurt', 200, 'g'], ['tinned tomatoes', 400, 'g'], ['garam masala', 2, 'tbsp']], ['Marinate chicken overnight.', 'Grill until charred.', 'Simmer in the sauce 20 min.']),
    R('Spaghetti bolognese', 4, ['pasta', 'kids'], [['beef mince', 500, 'g'], ['spaghetti', 400, 'g'], ['tinned tomatoes', 800, 'g'], ['onion', 1, 'ea']], ['Brown the mince.', 'Simmer sauce 45 min.', 'Serve with pasta.']),
    R('Vegetable stir-fry', 4, ['quick', 'vegetarian'], [['egg noodles', 300, 'g'], ['peppers', 2, 'ea'], ['soy sauce', 3, 'tbsp'], ['broccoli', 1, 'head']], ['Prep veg.', 'Stir-fry hot and fast.', 'Toss with noodles.']),
    R('Shakshuka', 2, ['breakfast', 'vegetarian'], [['eggs', 4, 'ea'], ['tinned tomatoes', 400, 'g'], ['red pepper', 1, 'ea'], ['cumin', 1, 'tsp']], ['Soften pepper and spices.', 'Add tomatoes, simmer.', 'Crack in eggs and cover.']),
    R('Beef chilli', 6, ['batch', 'spicy'], [['beef mince', 750, 'g'], ['kidney beans', 800, 'g'], ['chilli powder', 2, 'tsp'], ['rice', 400, 'g']], ['Brown the mince.', 'Add beans and spices.', 'Simmer 1 hour.']),
    R('Thai green curry', 4, ['curry'], [['coconut milk', 400, 'ml'], ['green curry paste', 3, 'tbsp'], ['chicken breast', 500, 'g'], ['jasmine rice', 300, 'g']], ['Fry paste.', 'Add coconut milk and chicken.', 'Serve on rice.']),
    R('Margherita pizza', 4, ['kids', 'friday'], [['strong flour', 500, 'g'], ['mozzarella', 250, 'g'], ['passata', 200, 'ml'], ['basil', 1, 'bunch']], ['Make dough, prove 2h.', 'Top thinly.', 'Bake at max heat.']),
    R('Leek and potato soup', 4, ['soup', 'vegetarian'], [['leeks', 3, 'ea'], ['potatoes', 500, 'g'], ['vegetable stock', 1, 'l'], ['cream', 100, 'ml']], ['Sweat leeks.', 'Simmer with potatoes.', 'Blend and finish with cream.']),
    R('Salmon traybake', 4, ['fish', 'quick'], [['salmon fillets', 4, 'ea'], ['new potatoes', 600, 'g'], ['green beans', 200, 'g'], ['lemon', 1, 'ea']], ['Roast potatoes 20 min.', 'Add salmon and beans.', 'Roast 12 min more.']),
    R('Mushroom risotto', 4, ['vegetarian'], [['arborio rice', 300, 'g'], ['mushrooms', 400, 'g'], ['parmesan', 60, 'g'], ['white wine', 150, 'ml']], ['Toast rice.', 'Add stock ladle by ladle.', 'Beat in butter and cheese.']),
    R('Toad in the hole', 4, ['kids', 'classic'], [['sausages', 8, 'ea'], ['plain flour', 140, 'g'], ['eggs', 3, 'ea'], ['milk', 200, 'ml']], ['Brown sausages in hot fat.', 'Pour in batter.', 'Bake 35 min, no peeking.']),
    R('Chickpea and spinach curry', 4, ['vegan', 'quick'], [['chickpeas', 800, 'g'], ['spinach', 200, 'g'], ['coconut milk', 400, 'ml'], ['curry powder', 2, 'tbsp']], ['Fry onion and spice.', 'Add chickpeas and coconut.', 'Wilt in spinach.']),
    R('Lasagne', 6, ['batch', 'pasta'], [['beef mince', 500, 'g'], ['lasagne sheets', 250, 'g'], ['milk', 600, 'ml'], ['cheddar', 150, 'g']], ['Make ragu.', 'Make bechamel.', 'Layer and bake 40 min.']),
    R('Fish finger sandwiches', 4, ['kids', 'quick'], [['fish fingers', 12, 'ea'], ['bread rolls', 4, 'ea'], ['tartare sauce', 4, 'tbsp'], ['lettuce', 1, 'ea']], ['Oven-cook fish fingers.', 'Build sandwiches.']),
    R('Ratatouille', 4, ['vegan'], [['aubergine', 1, 'ea'], ['courgettes', 2, 'ea'], ['peppers', 2, 'ea'], ['tinned tomatoes', 400, 'g']], ['Fry veg in batches.', 'Combine and simmer 30 min.']),
    R('Pork and apple burgers', 4, ['bbq'], [['pork mince', 500, 'g'], ['apple', 1, 'ea'], ['burger buns', 4, 'ea'], ['sage', 4, 'leaves']], ['Mix and shape.', 'Grill 5 min a side.']),
    R('Porridge with berries', 4, ['breakfast'], [['oats', 200, 'g'], ['milk', 800, 'ml'], ['frozen berries', 200, 'g'], ['honey', 2, 'tbsp']], ['Simmer oats in milk.', 'Top with berries and honey.']),
    R('Cottage pie', 6, ['batch', 'classic'], [['beef mince', 600, 'g'], ['potatoes', 1, 'kg'], ['carrots', 2, 'ea'], ['worcestershire sauce', 1, 'tbsp']], ['Make the mince filling.', 'Top with mash.', 'Bake until golden.']),
    R('Halloumi wraps', 4, ['vegetarian', 'quick'], [['halloumi', 250, 'g'], ['tortillas', 8, 'ea'], ['hummus', 200, 'g'], ['red onion', 1, 'ea']], ['Griddle halloumi.', 'Assemble wraps.']),
    R('Carbonara', 4, ['pasta', 'quick'], [['spaghetti', 400, 'g'], ['pancetta', 150, 'g'], ['eggs', 3, 'ea'], ['pecorino', 50, 'g']], ['Crisp pancetta.', 'Toss pasta off the heat with egg and cheese.']),
    R('Tomato and basil soup', 4, ['soup', 'vegan'], [['tomatoes', 1, 'kg'], ['basil', 1, 'bunch'], ['vegetable stock', 500, 'ml'], ['garlic', 2, 'cloves']], ['Roast tomatoes and garlic.', 'Blend with stock.']),
    R('Chicken fajitas', 4, ['kids', 'quick'], [['chicken breast', 500, 'g'], ['peppers', 3, 'ea'], ['tortillas', 8, 'ea'], ['sour cream', 150, 'ml']], ['Slice and season.', 'Fry hot.', 'Serve with wraps.']),
    R('Bean burritos', 4, ['vegetarian'], [['black beans', 800, 'g'], ['rice', 250, 'g'], ['tortillas', 4, 'ea'], ['cheddar', 100, 'g']], ['Cook rice.', 'Mash spiced beans.', 'Roll and toast.']),
    R('Lamb tagine', 6, ['slow'], [['lamb shoulder', 1, 'kg'], ['apricots', 150, 'g'], ['chickpeas', 400, 'g'], ['ras el hanout', 2, 'tbsp']], ['Brown lamb.', 'Slow cook 3 hours.', 'Serve with couscous.']),
    R('Banana bread', 8, ['baking'], [['bananas', 3, 'ea'], ['self-raising flour', 225, 'g'], ['butter', 100, 'g'], ['sugar', 100, 'g']], ['Mash bananas.', 'Mix everything.', 'Bake 1 hour at 170C.']),
    R('Prawn linguine', 4, ['fish', 'pasta'], [['linguine', 350, 'g'], ['prawns', 300, 'g'], ['cherry tomatoes', 250, 'g'], ['chilli', 1, 'ea']], ['Cook pasta.', 'Fry prawns with garlic and chilli.', 'Toss together.']),
    R('Jacket potatoes', 4, ['easy'], [['baking potatoes', 4, 'ea'], ['baked beans', 400, 'g'], ['cheddar', 100, 'g'], ['butter', 30, 'g']], ['Bake 75 min.', 'Fill and serve.']),
    R('Sausage casserole', 4, ['slow', 'kids'], [['sausages', 8, 'ea'], ['butter beans', 400, 'g'], ['tinned tomatoes', 400, 'g'], ['smoked paprika', 1, 'tsp']], ['Brown sausages.', 'Simmer everything 40 min.']),
    R('Egg fried rice', 4, ['quick'], [['cooked rice', 600, 'g'], ['eggs', 3, 'ea'], ['frozen peas', 150, 'g'], ['spring onions', 4, 'ea']], ['Scramble eggs.', 'Fry rice hot.', 'Fold together.']),
    R('Apple crumble', 6, ['dessert', 'baking'], [['bramley apples', 4, 'ea'], ['plain flour', 150, 'g'], ['butter', 100, 'g'], ['demerara sugar', 80, 'g']], ['Stew apples lightly.', 'Rub in crumble.', 'Bake 35 min.']),
  ];
  const existingRecipes = await all(HEORTH, '/api/v1/recipes', rowan);
  const recipeId = Object.fromEntries(existingRecipes.map((r) => [r.title, r.id]));
  for (const r of recipes) {
    const rec = await make('recipes', !!recipeId[r.title], () => H('POST', '/api/v1/recipes', { ...as(tok()), body: r }));
    if (rec) recipeId[r.title] = rec.id;
  }

  /* ---- meal plan: -84..+20 days, supper daily, weekend breakfast/lunch ---- */
  const existingPlan = (await H('GET', `/api/v1/meals/plan?from=${day(-84)}&to=${day(20)}`, { token: rowan })) ?? [];
  const planKeys = new Set((existingPlan.items ?? existingPlan).map((p) => `${p.date}|${p.slot}`));
  const freeTexts = ['Leftovers', 'Takeaway', 'Out for dinner', 'Beans on toast', 'Freezer surprise'];
  const recipePool = recipes.map((r) => r.title);
  reseed('meals');
  for (let n = -84; n <= 20; n++) {
    const slots = dow(n) === 0 || dow(n) === 6 ? ['breakfast', 'lunch', 'supper'] : ['supper'];
    for (const slot of slots) {
      const free = rnd() < 0.15;
      const body = { date: day(n), slot, recipeId: free ? null : recipeId[pick(recipePool)] ?? null, freeText: free ? pick(freeTexts) : null, cook: free ? null : mem[pick(adults)], helper: !free && rnd() < 0.4 ? mem[pick(kids)] : null };
      await make('meal plan', planKeys.has(`${day(n)}|${slot}`), () => H('POST', '/api/v1/meals/plan', { ...as(tok()), body }));
    }
  }

  /* ---- shopping list extras ---- */
  const shop = ['toilet roll', 'bin bags', 'dishwasher tablets', 'toothpaste', 'kitchen roll', 'bananas', 'apples', 'bread', 'milk', 'butter', 'cheddar', 'yoghurts', 'cereal', 'orange juice', 'batteries (AA)', 'sun cream', 'plasters', 'shampoo', 'tea bags', 'pasta'];
  const existingShop = (await H('GET', '/api/v1/meals/shopping-list', { token: rowan })) ?? [];
  const shopNames = new Set((existingShop.items ?? existingShop).map((i) => i.name));
  reseed('shopping');
  for (const name of shop) {
    const body = { name, qty: int(1, 3), unit: 'ea' };
    await make('shopping list', shopNames.has(name), () => H('POST', '/api/v1/meals/shopping-list', { ...as(tok()), body }));
  }

  /* ---- ethel: more places ---- */
  const existingPlaces = await H('GET', '/api/v1/ethel/places', { token: rowan });
  const placeBy = new Map((existingPlaces.items ?? existingPlaces).map((p) => [`${p.parentId ?? ''}|${p.name}`, p]));
  const placeId = Object.fromEntries((existingPlaces.items ?? existingPlaces).map((p) => [p.name, p.id]));
  const tree = [
    ['Living room', 'room', 'Ground floor'], ['Hallway', 'room', 'Ground floor'], ['Downstairs loo', 'room', 'Ground floor'],
    ['First floor', 'floor', 'House'], ['Main bedroom', 'room', 'First floor'], ['Wren’s room', 'room', 'First floor'], ['Tobin’s room', 'room', 'First floor'],
    ['Bathroom', 'room', 'First floor'], ['Landing cupboard', 'storage', 'First floor'], ['Loft', 'storage', 'House'], ['Cellar', 'storage', 'House'],
    ['Back garden', 'outdoor', 'Outside'], ['Greenhouse', 'outdoor', 'Back garden'], ['Patio', 'outdoor', 'Back garden'], ['Front garden', 'outdoor', 'Outside'],
  ];
  for (const [name, kind, parent] of tree) {
    const parentId = placeId[parent];
    const found = placeBy.get(`${parentId ?? ''}|${name}`);
    if (found) { placeId[name] = found.id; tally.places ??= { created: 0, existing: 0, failed: 0 }; tally.places.existing++; continue; }
    const rec = await make('places', false, () => H('POST', '/api/v1/ethel/places', { ...as(rowan), body: { name, kind, parentId } }));
    if (rec) placeId[name] = rec.id;
  }

  /* ---- ethel: ~45 more assets ---- */
  const A = (name, category, manufacturer, model, place, age, price, warrantyYears) => ({ name, category, manufacturer, model, placeId: placeId[place] ?? null, purchaseDate: day(-age), purchasePrice: price, warrantyUntil: warrantyYears ? day(-age + warrantyYears * 365) : undefined });
  const assets = [
    A('Samsung 55" TV', 'electronics', 'Samsung', 'QE55Q80C', 'Living room', 400, 899, 2), A('Sonos Beam soundbar', 'electronics', 'Sonos', 'Beam Gen 2', 'Living room', 380, 449, 2),
    A('Dyson V11 vacuum', 'appliance', 'Dyson', 'V11 Absolute', 'Landing cupboard', 700, 499, 2), A('Fridge freezer', 'appliance', 'Samsung', 'RB38T', 'Kitchen', 1300, 649, 5),
    A('Induction hob', 'appliance', 'Neff', 'T36FB41X0G', 'Kitchen', 1800, 529, 2), A('Oven', 'appliance', 'Neff', 'B57CR22N0B', 'Kitchen', 1800, 899, 2),
    A('Microwave', 'appliance', 'Panasonic', 'NN-CT56', 'Kitchen', 950, 249), A('Kettle', 'appliance', 'Russell Hobbs', 'Inspire', 'Kitchen', 200, 39),
    A('Toaster', 'appliance', 'Dualit', 'Classic 4-slot', 'Kitchen', 2200, 189), A('Coffee machine', 'appliance', 'Sage', 'Barista Express', 'Kitchen', 600, 549, 2),
    A('Tumble dryer', 'appliance', 'Bosch', 'WTH85223GB', 'Utility room', 900, 599, 2), A('Chest freezer', 'appliance', 'Beko', 'CF200', 'Cellar', 1600, 199),
    A('Wi-Fi router', 'network', 'AVM', 'FRITZ!Box 7590', 'Hallway', 500, 229), A('Mesh repeater', 'network', 'AVM', 'FRITZ!Repeater 3000', 'First floor', 480, 129),
    A('NAS', 'electronics', 'Synology', 'DS220+', 'Study', 650, 329, 2), A('Desk printer', 'electronics', 'Brother', 'HL-L2350DW', 'Study', 1000, 119),
    A('Monitor', 'electronics', 'Dell', 'U2723QE', 'Study', 300, 549, 3), A('iPad', 'electronics', 'Apple', 'iPad 10th gen', 'Living room', 350, 499, 1),
    A('Nintendo Switch', 'electronics', 'Nintendo', 'OLED', 'Tobin’s room', 420, 309, 1), A('Kids’ bunk bed', 'furniture', 'IKEA', 'Mydal', 'Tobin’s room', 1500, 179),
    A('Wren’s desk', 'furniture', 'IKEA', 'Alex', 'Wren’s room', 800, 129), A('Sofa', 'furniture', 'Loaf', 'Bagsie', 'Living room', 1200, 1495),
    A('Dining table', 'furniture', 'John Lewis', 'Calia', 'Kitchen', 2000, 799), A('King-size bed', 'furniture', 'Simba', 'Hybrid', 'Main bedroom', 900, 1099),
    A('Electric toothbrush', 'personal', 'Oral-B', 'iO 6', 'Bathroom', 250, 129), A('Hair dryer', 'personal', 'Dyson', 'Supersonic', 'Main bedroom', 500, 329, 2),
    A('Shower pump', 'plumbing', 'Salamander', 'CT50 Xtra', 'Landing cupboard', 1700, 289, 3), A('Smoke alarm (hall)', 'safety', 'FireAngel', 'ST-622', 'Hallway', 1100, 25),
    A('Smoke alarm (landing)', 'safety', 'FireAngel', 'ST-622', 'First floor', 1100, 25), A('CO detector', 'safety', 'Kidde', '7DCO', 'Utility room', 980, 29),
    A('Electric bike', 'vehicle', 'Raleigh', 'Motus Grand Tour', 'Garage', 540, 2299, 2), A('Wren’s bike', 'vehicle', 'Frog', '62', 'Shed', 300, 389),
    A('Tobin’s scooter', 'vehicle', 'Micro', 'Maxi Deluxe', 'Hallway', 200, 120), A('Pressure washer', 'tool', 'Kärcher', 'K4', 'Garage', 750, 199),
    A('Hedge trimmer', 'garden', 'Bosch', 'AHS 50-20 LI', 'Shed', 820, 119), A('Strimmer', 'garden', 'Ryobi', 'RY18LT', 'Shed', 640, 89),
    A('BBQ', 'garden', 'Weber', 'Spirit E-310', 'Patio', 1250, 549), A('Garden furniture set', 'garden', 'Hartman', 'Jamie', 'Patio', 1000, 699),
    A('Greenhouse heater', 'garden', 'Bio Green', 'Palma', 'Greenhouse', 400, 79), A('Ladder', 'tool', 'Youngman', '3-way combi', 'Garage', 2500, 159),
    A('Socket set', 'tool', 'Halfords', 'Advanced 200pc', 'Garage shelf', 1300, 99), A('Mitre saw', 'tool', 'DeWalt', 'DWS774', 'Garage', 480, 299, 3),
    A('Dehumidifier', 'appliance', 'Meaco', '20L Low Energy', 'Cellar', 700, 239, 2), A('Water softener', 'plumbing', 'Harvey', 'HS-Twin', 'Utility room', 1400, 1250, 5),
    A('Loft ladder', 'fixture', 'Youngman', 'Easiway', 'Loft', 2100, 129),
  ].map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)));
  const existingAssets = await all(HEORTH, '/api/v1/ethel/assets', rowan);
  const assetId = Object.fromEntries(existingAssets.map((a) => [a.name, a.id]));
  for (const a of assets) {
    const rec = await make('assets', !!assetId[a.name], () => H('POST', '/api/v1/ethel/assets', { ...as(rowan), body: a }));
    if (rec) assetId[a.name] = rec.id;
  }

  /* ---- weorc: more routines ---- */
  const routines = [
    ['Water the house plants', 'fixed', 'day', 3, 0], ['Clean the bathroom', 'fixed', 'week', 1, 0], ['Hoover downstairs', 'fixed', 'week', 1, 0],
    ['Mow the lawn', 'from_completion', 'week', 2, 1, { anchorAssetId: assetId['Honda lawnmower'] }], ['Test smoke alarms', 'fixed', 'month', 1, 0, { anchorAssetId: assetId['Smoke alarm (hall)'] }],
    ['Clean the oven', 'from_completion', 'month', 3, 3, { anchorAssetId: assetId['Oven'] }], ['Defrost the chest freezer', 'from_completion', 'month', 6, 7, { anchorAssetId: assetId['Chest freezer'] }],
    ['Empty the dehumidifier', 'from_completion', 'day', 4, 0, { anchorAssetId: assetId['Dehumidifier'] }], ['Refill water softener salt', 'from_completion', 'month', 2, 5, { anchorAssetId: assetId['Water softener'] }],
    ['Check tyre pressures', 'fixed', 'month', 1, 2, { anchorAssetId: assetId['Ford Focus estate'] }], ['Clean the gutters', 'from_completion', 'month', 6, 14, { anchorPlaceId: placeId['House'] }],
    ['Weed the front garden', 'from_completion', 'week', 3, 2, { anchorPlaceId: placeId['Front garden'] }], ['Back up the NAS offsite', 'fixed', 'month', 1, 0, { anchorAssetId: assetId['NAS'] }],
    ['Wash the car', 'from_completion', 'week', 4, 0], ['Clean the fridge', 'from_completion', 'month', 1, 0, { anchorAssetId: assetId['Fridge freezer'] }],
    ['Kids: tidy bedrooms', 'fixed', 'week', 1, 0], ['Descale the coffee machine', 'from_completion', 'month', 2, 3, { anchorAssetId: assetId['Coffee machine'] }],
  ];
  const existingRoutines = (await H('GET', '/api/v1/weorc/routines', { token: rowan })) ?? [];
  const routineNames = new Set(existingRoutines.map((r) => r.name));
  reseed('routines');
  for (const [name, mode, intervalUnit, intervalCount, leadDays, anchor = {}] of routines) {
    const body = { name, mode, intervalUnit, intervalCount, leadDays, anchorDate: day(-int(0, 20)), anchorAssetId: anchor.anchorAssetId ?? null, anchorPlaceId: anchor.anchorPlaceId ?? null };
    await make('weorc routines', routineNames.has(name), () => H('POST', '/api/v1/weorc/routines', { ...as(tok()), body }));
  }
  await H('POST', '/api/v1/weorc/run', { token: rowan, body: {} }).catch((e) => failures.push(`weorc run: ${e.message}`));
  const due = (await H('GET', '/api/v1/weorc/occurrences?status=due', { token: rowan }).catch(() => [])) ?? [];
  const done = (await H('GET', '/api/v1/weorc/occurrences?status=completed', { token: rowan }).catch(() => [])) ?? [];
  if (done.length < 8) for (const o of due.slice(0, 8)) await make('weorc completions', false, () => H('POST', `/api/v1/weorc/occurrences/${o.id}/complete`, { ...as(tok()), body: {} }));

  /* ---- feoh: ~6 months of transactions ---- */
  const accounts = Object.fromEntries(((await H('GET', '/api/v1/feoh/accounts', { token: rowan })) ?? []).map((a) => [a.name, a.id]));
  const envs = Object.fromEntries(((await H('GET', '/api/v1/feoh/envelopes', { token: rowan })) ?? []).map((e) => [e.name, e.id]));
  for (const e of [{ name: 'Housing', monthlyBudget: 1150, tone: 'taupe' }, { name: 'Clothing', monthlyBudget: 90 }, { name: 'Gifts', monthlyBudget: 50 }, { name: 'Health', monthlyBudget: 60 }, { name: 'Holidays', monthlyBudget: 150, tone: 'sky' }]) {
    const rec = await make('envelopes', !!envs[e.name], () => H('POST', '/api/v1/feoh/envelopes', { ...as(rowan), body: e }));
    if (rec) envs[e.name] = rec.id;
  }
  const existingTxns = await all(HEORTH, '/api/v1/feoh/transactions', rowan);
  const txnKeys = new Set(existingTxns.map((t) => `${t.date}|${t.payee}`));
  const planned = new Map();
  reseed('transactions');
  const spend = (n, payee, amount, env, acc = 'Joint current account', memo = null) => {
    const k = `${day(n)}|${payee}`;
    if (!planned.has(k) && envs[env] && accounts[acc]) planned.set(k, { date: day(n), payee, amount, memo, postings: [{ envelopeId: envs[env], debit: amount, credit: 0 }, { accountId: accounts[acc], debit: 0, credit: amount }] });
  };
  for (let n = -180; n <= -1; n++) {
    const d = new Date(ANCHOR); d.setUTCDate(d.getUTCDate() + n); const dom = d.getUTCDate(), wd = d.getUTCDay();
    if (dom === 1) spend(n, 'Ashcombe Building Society', 1085.4, 'Housing', 'Joint current account', 'Mortgage payment');
    if (dom === 3) spend(n, 'Council tax', 187, 'Utilities');
    if (dom === 5) spend(n, 'Northern Gas', money(95, 165), 'Utilities', 'Joint current account', 'Monthly direct debit');
    if (dom === 8) spend(n, 'Octopus Energy', money(70, 120), 'Utilities');
    if (dom === 12) spend(n, 'Netflix', 12.99, 'Subscriptions', 'Credit card');
    if (dom === 15) spend(n, 'Vodafone', 42.5, 'Utilities', 'Joint current account', 'Broadband + mobiles');
    if (dom === 20) spend(n, 'Ashcombe Water', 38.5, 'Utilities');
    if (dom === 27) spend(n, 'Spotify', 17.99, 'Subscriptions', 'Credit card', 'Family plan');
    if (dom === 25) {
      const k1 = `${day(n)}|Ashcombe Joinery Ltd (salary)`, k2 = `${day(n)}|County Council (salary)`;
      planned.set(k1, { date: day(n), payee: 'Ashcombe Joinery Ltd (salary)', amount: 2310, memo: 'Rowan — net pay', postings: [{ accountId: accounts['Joint current account'], debit: 2310, credit: 0 }, { envelopeId: envs['Income'], debit: 0, credit: 2310 }], splits: [{ memberId: mem.rowan, share: 2310 }] });
      planned.set(k2, { date: day(n), payee: 'County Council (salary)', amount: 1980, memo: 'Mira — net pay', postings: [{ accountId: accounts['Joint current account'], debit: 1980, credit: 0 }, { envelopeId: envs['Income'], debit: 0, credit: 1980 }], splits: [{ memberId: mem.mira, share: 1980 }] });
    }
    if (wd === 6) spend(n, pick(['Sainsbury’s', 'Tesco', 'Aldi', 'Lidl']), money(85, 165), 'Groceries');
    if (wd === 3 && rnd() < 0.7) spend(n, pick(['Co-op', 'REWE', 'Ashcombe Farm Shop', 'M&S Food']), money(15, 55), 'Groceries', rnd() < 0.3 ? 'Cash' : 'Joint current account');
    if (rnd() < 0.1) spend(n, pick(['Shell', 'BP', 'Esso', 'Tesco Petrol']), money(48, 78), 'Transport', 'Credit card');
    if (rnd() < 0.06) spend(n, pick(['The Fleece', 'Pizza Express', 'Wagamama', 'Golden Dragon', 'Fish & chip shop']), money(18, 85), 'Eating out', 'Credit card');
    if (rnd() < 0.04) spend(n, pick(['Screwfix', 'B&Q', 'Wickes', 'Toolstation']), money(8, 120), 'Home maintenance', 'Credit card');
    if (rnd() < 0.04) spend(n, pick(['Ashcombe Primary', 'Clarks', 'Smiggle', 'Waterstones', 'Ashcombe Baths']), money(10, 65), 'Kids & school');
    if (rnd() < 0.03) spend(n, pick(['Next', 'Uniqlo', 'M&S', 'Primark']), money(15, 110), 'Clothing', 'Credit card');
    if (rnd() < 0.02) spend(n, pick(['Boots', 'Superdrug', 'Specsavers']), money(6, 60), 'Health');
    if (rnd() < 0.015) spend(n, pick(['Amazon', 'John Lewis', 'Etsy']), money(12, 70), 'Gifts', 'Credit card', 'Birthday present');
    if (rnd() < 0.02) spend(n, 'Trainline', money(25, 140), 'Transport', 'Credit card');
  }
  spend(-95, 'Airbnb', 1340, 'Holidays', 'Credit card', 'Cornwall cottage — 10 nights');
  spend(-60, 'Halfords Autocentre', 289, 'Transport', 'Joint current account', 'Car service + brake pads');
  spend(-40, 'Dev Chaudhry Heating', 168, 'Home maintenance', 'Joint current account', 'Boiler service');
  for (const t of planned.values()) await make('transactions', txnKeys.has(`${t.date}|${t.payee}`), () => H('POST', '/api/v1/feoh/transactions', { ...as(tok()), body: t }));

  /* ---- feoh: more bills ---- */
  const existingBills = (await H('GET', '/api/v1/feoh/bills', { token: rowan })) ?? [];
  const billPayees = new Set(existingBills.map((b) => b.payee));
  const bills = [
    ['Ashcombe Building Society', 1085.4, 'monthly', day(4), 'Housing'], ['Octopus Energy', 95, 'monthly', day(11), 'Utilities'], ['Vodafone', 42.5, 'monthly', day(18), 'Utilities'],
    ['TV licence', 169.5, 'yearly', day(120), 'Utilities'], ['Home insurance', 312, 'yearly', day(150), 'Housing'], ['Breakdown cover', 89, 'yearly', day(64), 'Transport', 'Ford Focus estate'],
    ['Amazon Prime', 95, 'yearly', day(200), 'Subscriptions'], ['iCloud storage', 2.99, 'monthly', day(14), 'Subscriptions'], ['Disney+', 7.99, 'monthly', day(22), 'Subscriptions'],
    ['Football club subs', 60, 'quarterly', day(33), 'Kids & school'], ['Piano lessons', 120, 'monthly', day(3), 'Kids & school'], ['Gym membership', 34, 'monthly', day(7), 'Health'],
    ['Life insurance', 28.4, 'monthly', day(16), 'Housing'], ['Dentist plan', 18.5, 'monthly', day(9), 'Health'], ['Water softener service', 95, 'yearly', day(260), 'Home maintenance', 'Water softener'],
    ['Allotment rent', 45, 'yearly', day(180), 'Home maintenance'], ['Window cleaner (extra)', 12, 'semiannual', day(90), 'Home maintenance'], ['Newspaper delivery', 6.5, 'weekly', day(2), 'Subscriptions'],
  ];
  for (const [payee, amount, cadence, nextDue, env, asset] of bills) {
    await make('bills', billPayees.has(payee), () => H('POST', '/api/v1/feoh/bills', { ...as(rowan), body: { payee, amount, cadence, nextDue, envelopeId: envs[env] ?? null, ethelAssetId: asset ? assetId[asset] ?? null : null } }));
  }

  /* ---- feoh: inbox lines waiting for triage ---- */
  const existingLines = await all(HEORTH, '/api/v1/feoh/ingestion/inbox', rowan).catch(() => []);
  const lineIds = new Set(existingLines.map((l) => l.sourceId));
  const inboxPayees = ['REWE', 'Bakery on the corner', 'DM Drogerie', 'Aral', 'Deutsche Bahn', 'Rossmann', 'Edeka', 'Ikea', 'Kino Ashcombe', 'Apotheke', 'Northern Gas', 'Café Lotte', 'Decathlon', 'Thalia'];
  reseed('inbox');
  for (let i = 1; i <= 40; i++) {
    const sourceId = `bulk-${String(i).padStart(4, '0')}`;
    const payee = pick(inboxPayees);
    const body = { sourceId, sourceAccountId: 'demo-bank:joint', date: day(-int(0, 20)), payee, memo: rnd() < 0.5 ? `${payee.toUpperCase()} ${int(1000, 9999)}` : null, amount: money(3, 140), direction: 'out' };
    await make('import lines', lineIds.has(`manual:${sourceId}`), () => H('POST', '/api/v1/feoh/ingestion/inbox', { ...as(rowan), body }));
  }
}

/* ======================================================================= */

async function kithBulk() {
  if (!KITH_ADMIN_PASSWORD) { console.log('KITH_ADMIN_PASSWORD not set — skipping KithLedger'); return; }
  const { token } = await K('POST', '/api/v1/auth/token', { body: { email: 'admin@kithledger.local', password: KITH_ADMIN_PASSWORD } });
  const as = { token };

  const first = ['Aisha', 'Ben', 'Chloe', 'Daniel', 'Elena', 'Finn', 'Grace', 'Hugo', 'Imogen', 'Jonas', 'Keira', 'Liam', 'Maya', 'Noah', 'Olivia', 'Pete', 'Rosa', 'Theo', 'Uma', 'Victor', 'Willa', 'Yusuf', 'Zara', 'Felix', 'Lena', 'Marek', 'Sofia', 'Tom', 'Anika', 'Callum', 'Hannah', 'Ravi', 'Ingrid', 'Oscar', 'Leonie', 'Jamal', 'Clara', 'Ewan', 'Nina', 'Kofi'];
  const last = ['Fairley', 'Moreau', 'Brennan', 'Kowalski', 'Nakamura', 'Lindqvist', 'Adeyemi', 'Schröder', 'Castellano', 'O’Neill', 'Petrov', 'Haddad', 'Whitcombe', 'Duarte', 'Novak', 'Achterberg'];
  const tagSets = [['friend'], ['friend', 'school-gate'], ['colleague'], ['neighbour'], ['family'], ['service'], ['friend', 'book-club'], ['colleague', 'friend'], ['allotment'], ['football-parents']];
  const notes = ['Met at the school fete.', 'Works with Mira at the council.', 'Lives on Mill Lane.', 'Book club regular.', 'Coaches the U10s on Saturdays.', 'Old friend from Bristol days.', 'Very handy with bikes.', 'Vegetarian — remember for dinners.', 'Has two dogs, Biscuit and Mole.', 'Recently moved to Manchester.', null, null];
  reseed('people');
  const people = [];
  for (let i = 0; i < 40; i++) {
    const name = `${first[i]} ${last[(i * 7) % last.length]}`;
    const y = int(1955, 1995), m = int(1, 12), d = int(1, 28);
    people.push({ name, email: rnd() < 0.7 ? `${first[i].toLowerCase()}.${last[(i * 7) % last.length].toLowerCase().replace(/[^a-z]/g, '')}@demo.invalid` : null, phone: rnd() < 0.6 ? `+44 7700 9${String(int(0, 99999)).padStart(5, '0')}` : null, birthday: rnd() < 0.75 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null, tags: pick(tagSets), notes: pick(notes) });
  }
  const existing = await all(KITH, '/api/v1/people', token);
  const pid = Object.fromEntries(existing.map((p) => [p.name, p.id]));
  const birthdayOf = Object.fromEntries(existing.map((p) => [p.name, p.birthday ?? null]));
  for (const p of people) {
    const rec = await make('people', !!pid[p.name], () => K('POST', '/api/v1/people', { ...as, body: p }));
    if (rec) { pid[p.name] = rec.id; birthdayOf[p.name] = rec.birthday ?? null; }
  }
  // Only this script's own people, in a fixed order: never attach generated
  // history to real dev contacts, and never depend on the API's row order.
  const names = people.map((p) => p.name);

  const existingRels = await all(KITH, '/api/v1/relationships', token);
  const relKeys = new Set(existingRels.flatMap((r) => [`${r.fromPersonId}|${r.toPersonId}`, `${r.toPersonId}|${r.fromPersonId}`]));
  const relTypes = [['friend', 'friends'], ['family', 'siblings'], ['family', 'married to'], ['colleague', 'work together'], ['acquaintance', 'met through school'], ['friend', 'neighbours']];
  reseed('relationships');
  for (let i = 0; i < 35; i++) {
    const a = pid[pick(names)], b = pid[pick(names)];
    if (a === b) continue;
    const [type, label] = pick(relTypes);
    const exists = relKeys.has(`${a}|${b}`);
    relKeys.add(`${a}|${b}`); relKeys.add(`${b}|${a}`);
    await make('relationships', exists, () => K('POST', '/api/v1/relationships', { ...as, body: { fromPersonId: a, toPersonId: b, type, label, isMutual: true } }));
  }

  const existingInts = await all(KITH, '/api/v1/interactions', token);
  const intKeys = new Set(existingInts.map((i) => `${i.personId}|${new Date(i.occurredAt).toISOString()}`));
  const kinds = [['meeting', 'in-person'], ['call', 'phone'], ['message', 'sms'], ['message', 'social'], ['email', 'email'], ['call', 'video']];
  const intNotes = ['Caught up over coffee.', 'Quick chat at the school gate.', 'Long call — lots to catch up on.', 'Sent birthday wishes.', 'Arranged a playdate.', 'Talked about the allotment.', 'Asked for a plumber recommendation.', 'Shared holiday photos.', 'Dinner at theirs.', 'Bumped into them in town.', 'Discussed the football tournament.', 'Lent them the pressure washer.', 'They are having a tough time at work.', 'Disagreed about the parking — left it civil.'];
  reseed('interactions');
  for (let i = 0; i < 320; i++) {
    const who = pid[pick(names)], n = -int(1, 365), occurredAt = at(n, int(8, 21), pick([0, 15, 30, 45]));
    const [type, channel] = pick(kinds);
    const note = pick(intNotes);
    const body = { personId: who, occurredAt, type, channel, notes: note, sentiment: note.startsWith('Disagreed') || note.includes('tough') ? 'negative' : rnd() < 0.6 ? 'positive' : 'neutral' };
    await make('interactions', intKeys.has(`${who}|${occurredAt}`), () => K('POST', '/api/v1/interactions', { ...as, body }));
    intKeys.add(`${who}|${occurredAt}`);
  }

  const existingRems = await all(KITH, '/api/v1/reminders', token);
  const remTitles = new Set(existingRems.map((r) => r.title));
  const remTpl = ['Call {f}', 'Send {f} the recipe', 'Return {f}’s book', 'Invite {f} for dinner', 'Check in with {f}', 'Thank {f} for the help', 'Ask {f} about the holiday'];
  reseed('reminders');
  for (let i = 0; i < 35; i++) {
    const name = pick(names), f = name.split(' ')[0];
    const title = pick(remTpl).replace('{f}', f);
    const body = { personId: pid[name], dueAt: at(int(-10, 60), 9), title, recurrence: rnd() < 0.15 ? 'P30D' : null, kind: 'generic', leadDays: null };
    await make('reminders', remTitles.has(title), () => K('POST', '/api/v1/reminders', { ...as, body }));
    remTitles.add(title);
  }
  // The birthday as STORED, not as generated: a person row is never rewritten.
  for (const p of people.filter((x) => birthdayOf[x.name]).slice(0, 20)) {
    const f = p.name.split(' ')[0], title = `${f} — birthday`;
    const [, mm, dd] = String(birthdayOf[p.name]).slice(0, 10).split('-');
    let due = new Date(`2026-${mm}-${dd}T09:00:00Z`); if (due < ANCHOR) due = new Date(`2027-${mm}-${dd}T09:00:00Z`);
    await make('reminders', remTitles.has(title), () => K('POST', '/api/v1/reminders', { ...as, body: { personId: pid[p.name], dueAt: due.toISOString(), title, recurrence: null, kind: 'birthday', leadDays: 5 } }));
    remTitles.add(title);
  }
}

(async () => {
  console.log(`--- Heorth bulk (${HEORTH}) ---`);
  await heorthBulk();
  console.log(`--- KithLedger bulk (${KITH}) ---`);
  await kithBulk();
  console.log('\n--- bulk seeded ---');
  const w = Math.max(...Object.keys(tally).map((k) => k.length));
  for (const [k, n] of Object.entries(tally)) console.log(`  ${k.padEnd(w)}  ${String(n.created).padStart(4)} created, ${String(n.existing).padStart(3)} existing, ${n.failed} failed`);
  if (failures.length) { console.log('\nfirst failures:'); for (const f of failures) console.log('  ' + f); }
})().catch((e) => { console.error('bulk failed:', e.message); process.exit(1); });
