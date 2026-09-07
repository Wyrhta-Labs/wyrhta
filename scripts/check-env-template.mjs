#!/usr/bin/env node
// Assert that deploy/.env.example and the compose files agree on which
// environment variables exist.
//
//   node scripts/check-env-template.mjs
//
// WHY THIS EXISTS. This is not a monorepo (see repos.txt): deploy/ lives here,
// but the env *schema* that decides whether a stack boots lives in
// Wyrhta-Labs/Heorth (src/config/env.ts). Nothing compared the three, so a
// variable could be added to a compose file and to the schema while the
// template operators actually copy stayed behind — which is how KITH_PUBLIC_URL
// ended up referenced in two compose files and absent from the template.
//
// WHAT IT CANNOT SEE. Only the compose-vs-template half of the gap. A variable
// missing from BOTH files (LIBRARY_ENCRYPTION_KEY was) looks consistent from
// here; catching that needs a schema-vs-template check in Heorth's own CI.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = join(repoRoot, 'deploy');

const COMPOSE_FILES = ['compose.prod.yml', 'compose.dev.yml', 'compose.demo.yml'];
const TEMPLATE = '.env.example';

// Template keys no compose file interpolates, with the reason. Anything not
// listed here has to appear in a compose file or the check fails.
const TEMPLATE_ONLY = new Map([
  ['FIREFLY_OPERATOR_EMAIL', 'read by deploy/dev-up.mjs to bootstrap Firefly; never passed to a container'],
  ['FIREFLY_OPERATOR_PASSWORD', 'read by deploy/dev-up.mjs to bootstrap Firefly; never passed to a container'],
]);

// Compose variables that deliberately have no template entry.
const COMPOSE_ONLY = new Map();

/**
 * Every `${VAR}`, `${VAR:-default}` and `${VAR:?message}` in a compose file.
 * `$$VAR` is an escaped literal for the container and is not a compose
 * variable, so it is skipped.
 */
function composeVars(text) {
  const found = new Set();
  const pattern = /(\$*)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?][^}]*)?\}/g;
  for (const match of text.matchAll(pattern)) {
    // An even number of leading `$` escapes the one that follows.
    if (match[1].length % 2 === 1) continue;
    found.add(match[2]);
  }
  return found;
}

/**
 * Keys declared in the template, including commented-out ones such as
 * `# HEORTH_CORS_ORIGIN=*`. A commented key still tells an operator the
 * variable exists, which is the whole point of the template.
 */
function templateKeys(text) {
  const found = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

/** Variables a compose file guards with `${VAR:?…}` — required to start ANY container. */
function requiredVars(text) {
  const found = new Set();
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/g)) {
    found.add(match[1]);
  }
  return found;
}

/** The variables the template marks with a `# REQUIRED` line above them. */
function markedRequired(text) {
  const found = new Set();
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    const key = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(lines[i]);
    if (key && /^\s*#\s*REQUIRED\s*$/.test(lines[i - 1])) found.add(key[1]);
  }
  return found;
}

const templateText = readFileSync(join(deploy, TEMPLATE), 'utf8');
const template = templateKeys(templateText);

const usedIn = new Map(); // VAR -> [compose files]
const required = new Map(); // VAR -> [compose files that guard it with :?]
for (const file of COMPOSE_FILES) {
  const text = readFileSync(join(deploy, file), 'utf8');
  for (const name of composeVars(text)) {
    if (!usedIn.has(name)) usedIn.set(name, []);
    usedIn.get(name).push(file);
  }
  for (const name of requiredVars(text)) {
    if (!required.has(name)) required.set(name, []);
    required.get(name).push(file);
  }
}

const problems = [];

// 1. A compose variable with no template entry: an operator following the
//    template ends up with a file the stack does not accept.
for (const [name, files] of [...usedIn].sort()) {
  if (template.has(name) || COMPOSE_ONLY.has(name)) continue;
  problems.push(`${name} is used in ${files.join(', ')} but missing from deploy/${TEMPLATE}`);
}

// 2. A template key no compose file uses: either dead weight or a variable
//    someone forgot to pass through to the container.
for (const name of [...template].sort()) {
  if (usedIn.has(name) || TEMPLATE_ONLY.has(name)) continue;
  problems.push(`${name} is in deploy/${TEMPLATE} but no compose file uses it`);
}

// 3. `:?`-guarded variables must be marked REQUIRED in the template. Compose
//    validates the whole model before starting anything, so a blank one fails
//    the bring-up even when the feature it belongs to is off — and a deployer
//    should not have to discover that one failed `up` at a time.
const marked = markedRequired(templateText);
for (const [name, files] of [...required].sort()) {
  if (!template.has(name)) continue; // already reported by check 1
  if (marked.has(name)) continue;
  // compose.demo.yml is driven by generated .env.demo, not by the template.
  if (files.every((f) => f === 'compose.demo.yml')) continue;
  problems.push(
    `${name} is \${VAR:?}-guarded in ${files.join(', ')} but not marked ` +
      `with a "# REQUIRED" line in deploy/${TEMPLATE}`,
  );
}
for (const name of [...marked].sort()) {
  if (required.has(name)) continue;
  problems.push(`${name} is marked "# REQUIRED" in deploy/${TEMPLATE} but no compose file guards it with \${VAR:?}`);
}

// 4. A value line must not carry a trailing comment: deploy/dev-up.mjs parses
//    this file as `KEY=rest-of-line` and would take the comment for the value.
for (const [index, line] of templateText.split(/\r?\n/).entries()) {
  const match = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
  if (match && match[2].includes('#')) {
    problems.push(
      `deploy/${TEMPLATE}:${index + 1}: ${match[1]} has a trailing comment on its value line — ` +
        'put the comment on its own line (dev-up.mjs would read it as the value)',
    );
  }
}

if (problems.length > 0) {
  console.error(`deploy/${TEMPLATE} and the compose files disagree:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nFix the template or the compose file. A variable that legitimately belongs to only one ' +
      'of them goes in TEMPLATE_ONLY or COMPOSE_ONLY in this script, with the reason.',
  );
  process.exit(1);
}

console.log(
  `deploy/${TEMPLATE} covers all ${usedIn.size} compose variables across ` +
    `${COMPOSE_FILES.join(', ')} (${required.size} of them \${VAR:?}-guarded).`,
);
