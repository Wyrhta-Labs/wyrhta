#!/usr/bin/env node
// Bring up the Wyrhta local development stack, from nothing, in one command.
//
//   deploy/dev-up.sh              # bash / Git Bash / WSL
//   deploy\dev-up.ps1             # PowerShell
//   node deploy/dev-up.mjs        # anywhere
//
// WHY NODE AND NOT BASH. deploy/demo-up.sh is bash and needs a documented
// PowerShell fallback because `bash` on Windows may resolve to WSL and fail
// with E_ACCESSDENIED (docs/local-environments.md). node is already a hard
// dependency of this repo's tooling — demo-up.sh shells out to it for secrets
// and for seed-demo.mjs — so putting the logic here gives one implementation
// that behaves identically in Git Bash, PowerShell and WSL. The two wrappers
// beside this file are three lines each and hold no logic.
//
// WHAT IT DOES TO deploy/.env:
//   Creates it from .env.example when absent, then fills ONLY keys that are
//   missing or empty. An existing value is never overwritten, so running this
//   against a .env you have already filled is safe and additive.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - It never deletes a volume. The dev cluster holds real local development
//     data; there is no --fresh flag here on purpose (the demo has one because
//     the demo's data is disposable).
//   - It never invents an EXTERNAL credential. M365_* and KITH_API_KEY stay
//     blank and are reported as blank. FIREFLY_PAT is not one of those: Firefly
//     is a container we own, so the script mints that token itself.
//   - It never prints a secret. It prints where to read them.

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const composeFile = join(here, 'compose.dev.yml');
const envFile = join(here, '.env');
const envExample = join(here, '.env.example');

const PROJECT = 'wyrhta-dev';
const DB_VOLUME = `${PROJECT}_db_data`;

// Services the script blocks on. firefly is NOT here: nothing depends on it
// (ADR 0016 — Firefly being down pauses the import and nothing else), and its
// first boot runs Laravel migrations, so waiting on it would make the common
// case slow for no benefit. Its status is reported, not awaited.
const REQUIRED = ['db', 'kithledger', 'heorth', 'heorth-mcp'];

const HTTP_PROBES = [
  ['Heorth', 'http://localhost:14000/health'],
  ['KithLedger', 'http://localhost:14002/health'],
  ['heorth-mcp', 'http://localhost:14003/health'],
];

// ---------------------------------------------------------------------------
// args

const args = process.argv.slice(2);
let build = true;
for (const arg of args) {
  switch (arg) {
    case '--no-build':
      build = false;
      break;
    case '-h':
    case '--help':
      console.log(
        [
          'deploy/dev-up.sh [--no-build]',
          '',
          '  Fills deploy/.env with generated local dev secrets (existing values',
          '  are never overwritten), builds and starts compose.dev.yml, ensures',
          "  Firefly's database exists, mints its personal access token and turns",
          '  bank ingestion on, waits for health, and prints the URLs.',
          '',
          '  --no-build   start without rebuilding the service images',
        ].join('\n'),
      );
      process.exit(0);
      break;
    default:
      console.error(`unknown option: ${arg}`);
      process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// small helpers

const log = (msg) => console.log(`==> ${msg}`);
const warn = (msg) => console.log(`!!  ${msg}`);

const hex = (bytes) => randomBytes(bytes).toString('hex');

/** A single-line Ed25519 JWK, matching the generator in .env.example. */
function satelliteSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  jwk.alg = 'EdDSA';
  jwk.use = 'sig';
  jwk.kid = satelliteKid();
  return JSON.stringify(jwk);
}

function satelliteKid() {
  const now = new Date();
  return `heorth-dev-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function compose(...rest) {
  return ['compose', '-f', composeFile, '--env-file', envFile, ...rest];
}

function docker(argv, opts = {}) {
  return execFileSync('docker', argv, { encoding: 'utf8', ...opts });
}

/**
 * Run docker with its output going straight to the terminal. On failure, say
 * what failed and stop — docker has already printed the real diagnosis, and a
 * node stack trace on top of it only buries the useful line.
 */
function dockerInherit(argv) {
  try {
    execFileSync('docker', argv, { stdio: 'inherit' });
  } catch {
    console.error('');
    console.error(`failed: docker ${argv.join(' ')}`);
    console.error('The docker output above is the diagnosis. Common causes:');
    console.error('  - Docker Desktop is not running');
    console.error('  - a published port is taken — the demo stack uses 24000/24002/24003,');
    console.error('    and each service repo has its own compose file that can collide');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// env file

/** Parse into a Map, preserving nothing else — we rewrite by line, not by dump. */
function readEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

/**
 * Set a key in place, or append it. Rewrites the single line and leaves every
 * comment and blank line where it was — this file is documentation as much as
 * configuration.
 */
function setEnvValue(text, name, value) {
  const pattern = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
  const line = `${name}=${value}`;
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text}${text.endsWith('\n') ? '' : '\n'}${line}\n`;
}

// Generated only when missing or empty. Order is cosmetic.
const GENERATED = [
  ['POSTGRES_SUPERUSER_PASSWORD', () => hex(32)],
  ['HEORTH_DB_PASSWORD', () => hex(32)],
  ['KITH_DB_PASSWORD', () => hex(32)],
  ['FIREFLY_DB_PASSWORD', () => hex(32)],
  // Both JWT secrets are drawn independently, so they cannot collide. A shared
  // secret would make a token minted by one service valid at the other.
  ['HEORTH_JWT_SECRET', () => hex(32)],
  ['KITH_JWT_SECRET', () => hex(32)],
  ['HEORTH_ADMIN_PASSWORD', () => hex(16)],
  ['KITH_ADMIN_PASSWORD', () => hex(16)],
  ['SATELLITE_SIGNING_KEY', satelliteSigningKey],
  ['SATELLITE_SIGNING_KID', satelliteKid],
  // Firefly refuses to boot unless APP_KEY is exactly 32 characters.
  ['FIREFLY_APP_KEY', () => hex(16)],
  // Local-dev identity. Overwrite them in deploy/.env if you want your own.
  ['HOUSEHOLD_NAME', () => 'Wyrhta Dev Household'],
  ['HEORTH_ADMIN_EMAIL', () => 'admin@dev.invalid'],
  // Firefly's operator account, created by fireflyBootstrap() below. Kept in
  // deploy/.env so a later run can log in again instead of being locked out of
  // an instance it created itself. Firefly enforces a 16-character minimum.
  ['FIREFLY_OPERATOR_EMAIL', () => 'operator@dev.invalid'],
  ['FIREFLY_OPERATOR_PASSWORD', () => hex(16)],
];

// Left blank on purpose: every one of these reaches a real external system.
// Reported at the end, never invented. FIREFLY_PAT is NOT here — Firefly is a
// container we own, so we can mint that one ourselves.
const EXTERNAL = [
  'M365_TENANT_ID',
  'M365_CLIENT_ID',
  'M365_CLIENT_SECRET',
  'M365_REDIRECT_URI',
  'M365_FAMILY_MAILBOX',
  'M365_SHARED_TODO_LIST',
  'KITH_API_KEY',
];

function ensureEnvFile() {
  const created = !existsSync(envFile);
  if (created) {
    if (!existsSync(envExample)) {
      console.error(`missing ${envExample} — cannot create deploy/.env`);
      process.exit(1);
    }
    copyFileSync(envExample, envFile);
    log('created deploy/.env from .env.example');
  }

  let text = readFileSync(envFile, 'utf8');
  const values = readEnv(text);
  const filled = [];

  for (const [name, generate] of GENERATED) {
    const current = values.get(name);
    if (current !== undefined && current !== '') continue;
    text = setEnvValue(text, name, generate());
    filled.push(name);
  }

  if (filled.length > 0) {
    writeFileSync(envFile, text);
    log(`filled ${filled.length} blank value(s) in deploy/.env: ${filled.join(', ')}`);
  } else {
    log('deploy/.env already complete — nothing generated');
  }

  return { created, filled, values: readEnv(readFileSync(envFile, 'utf8')) };
}

// ---------------------------------------------------------------------------
// the live cluster

function volumeExists(name) {
  try {
    docker(['volume', 'inspect', name], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * initdb/10-databases.sh runs ONCE, and only on an empty data directory, so on
 * a cluster that already exists Firefly's role and database have to be created
 * by hand — the manual step deploy/README.md documents for adding a service to
 * a live cluster. Idempotent: existing role and database are left alone.
 */
function ensureFireflyDatabase(env) {
  const password = env.get('FIREFLY_DB_PASSWORD');
  if (!password) {
    warn('FIREFLY_DB_PASSWORD is blank — skipping the firefly database');
    return;
  }

  // The password arrives as a psql variable and is escaped by quote_literal,
  // never spliced into the SQL text here. \gexec runs the string the SELECT
  // produced, which is how CREATE ROLE / CREATE DATABASE — neither of which
  // has an IF NOT EXISTS — are made idempotent. Not indented: psql wants its
  // backslash commands at the start of a line.
  const sql = [
    "SELECT 'CREATE ROLE firefly LOGIN PASSWORD ' || quote_literal(:'pw')",
    // No trailing semicolon: \gexec sends the CURRENT query buffer, and a
    // semicolon would have already flushed it, leaving \gexec nothing to run.
    " WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'firefly')",
    '\\gexec',
    "SELECT 'CREATE DATABASE firefly_dev OWNER firefly'",
    " WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'firefly_dev')",
    '\\gexec',
    'REVOKE ALL ON DATABASE firefly_dev FROM PUBLIC;',
    '',
  ].join('\n');

  try {
    docker(
      compose(
        'exec',
        '-T',
        '-e',
        `PGPASSWORD=${env.get('POSTGRES_SUPERUSER_PASSWORD')}`,
        'db',
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-v',
        `pw=${password}`,
        '-U',
        'postgres',
        '-d',
        'postgres',
      ),
      { input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    log("ensured role 'firefly' and database 'firefly_dev'");
  } catch (error) {
    warn(`could not ensure the firefly database: ${String(error.stderr || error.message).trim()}`);
    warn('Firefly will restart-loop until it exists. See deploy/README.md, "Databases".');
  }
}

// ---------------------------------------------------------------------------
// Firefly bootstrap
//
// Firefly mints personal access tokens through its web UI only — there is no
// artisan command and no API for it. So this drives that UI: it registers the
// first user through `POST /register` and asks Passport for a token through
// `POST /oauth/personal-access-tokens`, exactly as a browser would.
//
// THIS IS THE ONE PLACE IN THE STACK COUPLED TO SOMEONE ELSE'S HTML. Everything
// else here talks to a documented API. That is why the Firefly image is pinned
// to an exact version, and why every step below fails soft: a Firefly upgrade
// that renames a form field must degrade to "do it by hand", never break the
// bring-up of a stack that does not otherwise need Firefly at all.
//
// DEV ONLY. It leaves the instance with an operator password sitting in
// deploy/.env, which is right for a local throwaway and wrong everywhere else.
// compose.prod.yml neither calls this nor knows it exists.

/** The smallest cookie jar that survives Laravel's session + redirect dance. */
function makeJar() {
  const jar = new Map();
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(response) {
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
  };
}

/** Laravel puts the CSRF token in a hidden _token input on every form. */
function csrfFrom(html) {
  const match =
    /name="_token"[^>]*value="([^"]+)"/.exec(html) ?? /value="([^"]+)"[^>]*name="_token"/.exec(html);
  return match?.[1] ?? null;
}

async function fireflyBootstrap(env, baseUrl) {
  const jar = makeJar();

  const get = async (path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Cookie: jar.header() },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    jar.absorb(response);
    return response;
  };

  const post = async (path, body, extraHeaders = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Cookie: jar.header(), ...extraHeaders },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    jar.absorb(response);
    return response;
  };

  const email = env.get('FIREFLY_OPERATOR_EMAIL');
  const password = env.get('FIREFLY_OPERATOR_PASSWORD');

  // Passport 12 ships no personal-access client on a fresh install, and
  // /oauth/personal-access-tokens fails without one. Idempotent in effect: a
  // second client would work too, but we only create one when none exists.
  const clients = docker(
    compose('exec', '-T', 'firefly', 'php', 'artisan', 'passport:client', '--personal', '--name=wyrhta-dev', '--no-interaction'),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (!/created successfully/i.test(clients)) {
    throw new Error(`passport:client did not report success: ${clients.trim().slice(0, 200)}`);
  }

  // Register the operator, or log in when this instance already has one.
  //
  // FIREFLY CLOSES REGISTRATION AS SOON AS A USER EXISTS: /register then answers
  // 200 with an error page carrying no form at all. So a missing CSRF token here
  // is an ordinary second-run state, not a failure — falling through to /login
  // is the whole point. Only a failure of BOTH paths is worth an error.
  let session = false;

  const registerPage = await get('/register');
  const registerToken = csrfFrom(await registerPage.text());
  if (registerToken) {
    const registered = await post(
      '/register',
      new URLSearchParams({
        _token: registerToken,
        email,
        password,
        password_confirmation: password,
        // verify_password is DELIBERATELY ABSENT. It is Firefly's
        // Have-I-Been-Pwned check, and sending it would make bringing up a
        // local dev stack call a third-party service.
      }),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    session = registered.status === 302;
  }

  if (!session) {
    const login = await get('/login');
    const loginToken = csrfFrom(await login.text());
    if (!loginToken) {
      throw new Error('neither /register nor /login offered a form — Firefly may have changed');
    }
    const loggedIn = await post(
      '/login',
      new URLSearchParams({ _token: loginToken, email, password }),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    if (loggedIn.status !== 302) {
      throw new Error(
        `cannot register or log in as ${email}. If you created this Firefly account by ` +
          'hand, put its password in FIREFLY_OPERATOR_PASSWORD, or mint a PAT yourself.',
      );
    }
  }

  // Logging in regenerates the session, so the token must be read again.
  const profile = await get('/profile');
  const profileToken = csrfFrom(await profile.text());
  if (!profileToken) throw new Error('no CSRF token on /profile — not logged in?');

  const created = await post(
    '/oauth/personal-access-tokens',
    JSON.stringify({ name: 'wyrhta-dev', scopes: [] }),
    {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRF-TOKEN': profileToken,
      'X-Requested-With': 'XMLHttpRequest',
    },
  );
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`POST /oauth/personal-access-tokens returned ${created.status}`);
  }
  const token = (await created.json()).accessToken;
  if (!token) throw new Error('Passport returned no accessToken');

  // Prove it before writing it anywhere. A token that parses but is rejected
  // would otherwise turn into a confusing Heorth error hours later.
  const about = await fetch(`${baseUrl}/api/v1/about`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!about.ok) throw new Error(`the new token was rejected by /api/v1/about (${about.status})`);

  return token;
}

/**
 * Obtain and persist FIREFLY_PAT, then turn the import feed on. Returns a short
 * status string for the summary. Never throws: bank ingestion is optional, and
 * a stack that is otherwise healthy must not be reported as failed because a
 * sidecar could not be bootstrapped.
 */
async function ensureFireflyPat(env) {
  if (env.get('FIREFLY_PAT')) return 'enabled (token already in deploy/.env)';
  if (!env.get('FIREFLY_DB_PASSWORD')) return 'skipped (no FIREFLY_DB_PASSWORD)';

  const baseUrl = env.get('FIREFLY_APP_URL') || 'http://localhost:14001';

  log('bootstrapping Firefly: operator account + personal access token');
  if (!(await waitHealthy(['firefly'], 300_000))) {
    warn('Firefly did not become healthy in time — skipping the token bootstrap');
    return 'not bootstrapped (Firefly unhealthy)';
  }

  let token;
  try {
    token = await fireflyBootstrap(env, baseUrl);
  } catch (error) {
    warn(`could not bootstrap Firefly: ${error.message}`);
    warn('The stack is fine — bank ingestion just stays off. Mint a token by hand at');
    warn(`${baseUrl} (Profile -> OAuth -> Personal Access Tokens) and put it in`);
    warn('deploy/.env as FIREFLY_PAT, then re-run.');
    return 'not bootstrapped (see the warning above)';
  }

  let text = readFileSync(envFile, 'utf8');
  text = setEnvValue(text, 'FIREFLY_PAT', token);
  text = setEnvValue(text, 'FEOH_IMPORT_ENABLED', 'true');
  writeFileSync(envFile, text);
  log('wrote FIREFLY_PAT to deploy/.env and set FEOH_IMPORT_ENABLED=true');

  // Both containers read the token from the environment at start, so they have
  // to be recreated for it to take effect. Wait for heorth to come back before
  // returning: without this the summary below reports the stack it just tore
  // down, and says "unreachable" about a service that is merely restarting.
  dockerInherit(compose('up', '-d', 'heorth', 'firefly-importer'));
  if (!(await waitHealthy(['heorth', 'firefly-importer'], 300_000))) {
    warn('heorth did not come back healthy after picking up the new token');
    return 'token minted, but heorth did not restart cleanly';
  }
  return 'enabled (token minted this run)';
}

function healthOf(service) {
  let id;
  try {
    id = docker(compose('ps', '-q', service), { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'missing';
  }
  if (!id) return 'missing';
  try {
    return docker(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealthy(services, timeoutMs) {
  log(`waiting for: ${services.join(', ')}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = services.map((service) => [service, healthOf(service)]);
    const pending = states.filter(([, state]) => state !== 'healthy' && state !== 'running');
    if (pending.length === 0) return true;
    if (Date.now() > deadline) {
      warn(`timed out: ${pending.map(([s, state]) => `${s}(${state})`).join(' ')}`);
      return false;
    }
    await sleep(3000);
  }
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok ? 'ok' : `HTTP ${response.status}`;
  } catch (error) {
    return `unreachable (${error.name})`;
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const volumeWasThere = volumeExists(DB_VOLUME);
  const { created, filled, values } = ensureEnvFile();

  // A regenerated superuser password against an existing cluster does NOT
  // change the cluster — Postgres keeps the role it was initialised with, and
  // every connection then fails authentication. Worth shouting about, because
  // the symptom (everything unhealthy) does not point at the cause.
  if (volumeWasThere && filled.includes('POSTGRES_SUPERUSER_PASSWORD')) {
    warn(`the ${DB_VOLUME} volume already exists but deploy/.env had no database`);
    warn('passwords, so fresh ones were generated. They will NOT match the roles');
    warn('already in that cluster. Either restore the old deploy/.env, or reset');
    warn(`the roles with ALTER ROLE ... PASSWORD via 'docker compose exec db psql'.`);
  }

  log(build ? 'building and starting the dev stack' : 'starting the dev stack');
  dockerInherit(compose('up', '-d', ...(build ? ['--build'] : [])));

  ensureFireflyDatabase(values);

  // Firefly may have started before its database existed. Restarting it here
  // is cheaper than making the operator work out why it is looping.
  if (values.get('FIREFLY_DB_PASSWORD')) {
    try {
      docker(compose('restart', 'firefly'), { stdio: 'ignore' });
    } catch {
      /* not fatal — the status line below tells the truth either way */
    }
  }

  const healthy = await waitHealthy(REQUIRED, 300_000);

  // After the required services, because it recreates heorth: doing it earlier
  // would mean waiting for heorth to come healthy twice.
  const ingestion = await ensureFireflyPat(values);

  console.log('');
  log('health');
  for (const [name, url] of HTTP_PROBES) {
    console.log(`    ${name.padEnd(12)} ${url.padEnd(40)} ${await probe(url)}`);
  }
  console.log(`    ${'Firefly'.padEnd(12)} ${'http://localhost:14001'.padEnd(40)} ${healthOf('firefly')}`);
  console.log(`    ${'Importer'.padEnd(12)} ${'http://localhost:14004'.padEnd(40)} ${healthOf('firefly-importer')}`);
  console.log(`    ${'Postgres'.padEnd(12)} ${'localhost:15432'.padEnd(40)} ${healthOf('db')}`);

  console.log('');
  log('logins');
  console.log(`    Heorth admin   ${values.get('HEORTH_ADMIN_EMAIL')}`);
  console.log('    passwords      deploy/.env (HEORTH_ADMIN_PASSWORD, KITH_ADMIN_PASSWORD)');
  console.log('                   Never paste them into chat, issues or logs.');

  console.log('');
  log('bank ingestion');
  console.log(`    ${ingestion}`);
  console.log('    Firefly operator  ' + values.get('FIREFLY_OPERATOR_EMAIL'));
  console.log('    password          deploy/.env (FIREFLY_OPERATOR_PASSWORD)');

  const blank = EXTERNAL.filter((name) => !values.get(name));
  if (blank.length > 0) {
    console.log('');
    log('left blank on purpose — these reach real external systems');
    console.log(`    ${blank.join(', ')}`);
  }

  console.log('');
  if (created) {
    log('deploy/.env is git-ignored. It is part of the restore path for backups —');
    log('keep it somewhere safe, and never commit it.');
  }

  // Re-checked rather than trusting the earlier wait: ensureFireflyPat may have
  // recreated heorth since then. Firefly itself is excluded on purpose — bank
  // ingestion is optional, so a sidecar that failed to come up is a warning,
  // not a non-zero exit.
  const stillHealthy = REQUIRED.every((service) => {
    const state = healthOf(service);
    return state === 'healthy' || state === 'running';
  });
  process.exit(healthy && stillHealthy ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
