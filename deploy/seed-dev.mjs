/**
 * Fills the DEV stack (deploy/compose.dev.yml) with the demo household's
 * sample data, on request. Then run deploy/seed-dev-bulk.mjs for volume.
 *
 *   node deploy/seed-dev.mjs
 *
 * Reads deploy/.env itself (values already in the environment win) and runs
 * deploy/seed-demo.mjs against http://localhost:14000 / :14002 with:
 *
 *   SEED_KEEP_HOUSEHOLD=1  the dev household keeps its name, timezone, locale
 *   SEED_SKIP_GEWRIT=1     dev talks to a REAL Paperless; the demo's document
 *                          ids 1-4 would link real documents to demo assets
 *
 * This deliberately writes into heorth_dev / kithledger_dev, which the demo
 * stack never does. It adds four members (rowan/mira/wren/tobin@demo.invalid,
 * password DEMO_MEMBER_PASSWORD or demo-member-pw) and their content next to
 * whatever is already there. Idempotent; never deletes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('./.env', import.meta.url));
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!m || process.env[m[1]] !== undefined) continue;
  process.env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
}

process.env.HEORTH_URL ??= 'http://localhost:14000';
process.env.KITH_URL ??= 'http://localhost:14002';
process.env.SEED_KEEP_HOUSEHOLD = '1';
process.env.SEED_SKIP_GEWRIT = '1';

await import('./seed-demo.mjs');
