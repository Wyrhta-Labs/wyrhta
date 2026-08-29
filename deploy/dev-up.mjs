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
//   - It never invents an EXTERNAL credential. M365_*, KITH_API_KEY and
//     FIREFLY_PAT stay blank and are reported as blank.
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
          "  Firefly's database exists, waits for health, and prints the URLs.",
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
];

// Left blank on purpose: every one of these reaches a real external system or
// must be minted by hand. Reported at the end, never invented.
const EXTERNAL = [
  'M365_TENANT_ID',
  'M365_CLIENT_ID',
  'M365_CLIENT_SECRET',
  'M365_REDIRECT_URI',
  'M365_FAMILY_MAILBOX',
  'M365_SHARED_TODO_LIST',
  'KITH_API_KEY',
  'FIREFLY_PAT',
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

  const blank = EXTERNAL.filter((name) => !values.get(name));
  if (blank.length > 0) {
    console.log('');
    log('left blank on purpose — these reach real external systems');
    console.log(`    ${blank.join(', ')}`);
  }

  if (!values.get('FIREFLY_PAT')) {
    console.log('');
    log('to finish the bank-ingestion sidecar (optional — the stack works without it)');
    console.log('    1. open http://localhost:14001 and register the operator account');
    console.log('    2. Profile -> OAuth -> Personal Access Tokens -> Create new token');
    console.log('    3. paste it into deploy/.env as FIREFLY_PAT (it is shown once)');
    console.log('    4. set FEOH_IMPORT_ENABLED=true, then re-run deploy/dev-up.sh');
    console.log('    Firefly mints tokens through its UI only; no script can do this step.');
  }

  console.log('');
  if (created) {
    log('deploy/.env is git-ignored. It is part of the restore path for backups —');
    log('keep it somewhere safe, and never commit it.');
  }

  process.exit(healthy ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
