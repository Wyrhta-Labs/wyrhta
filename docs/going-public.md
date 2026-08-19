# Going public — audit and checklist

**Scanned:** 2026-08-19 · all six repos (`wyrhta`, `wyrhta-core`, `Heorth`,
`KithLedger`, `heorth-mcp`, `website`), working trees **and** full history
(`git log --all -p`), plus the untracked-but-present files in this checkout.

Current visibility: `wyrhta-core` and `website` are already public; `wyrhta`,
`Heorth`, `KithLedger`, `heorth-mcp` are private; `Feoh` is private + archived.

**Headline: no live secret was found in any repo's history.** No `.env` was ever
committed, in any of the six. No private key, no PAT, no cloud credential, no
`kl_`/`he_` key value. The CI workflows use throwaway CI passwords and the
built-in `secrets.GITHUB_TOKEN`. What blocks the flip is **household PII and
tenant identifiers in this repo's docs**, and the fact that **no repo has a
licence**.

---

## Blockers — fix before flipping visibility

### 1. `docs/manual-todo.md` is an operator's private ops log, tracked in git

It is the single worst file for publication, and it is in this repo's history, so
deleting it now is not enough.

| Lines | What leaks |
|---|---|
| 11–12 | The Entra **client ID** and **tenant ID** of the household tenant |
| 34, 43–44, 48, 53, 72, 330 | The family shared mailbox and a mail-enabled security group |
| 39, 55, 57, 62, 202, 323 | Two personal mailboxes (the maintainer's and his partner's) |
| 21, 99 | The household's real internal FQDN and its registered OAuth redirect URI |
| 234–243 | KithLedger credential **prefixes and record ids** (not the key values) |
| throughout | Household member names, calendar contents, dev-host layout, which databases were never migrated |

Microsoft does not treat a tenant or client ID as a secret, and the key
*prefixes* are not the keys. Taken individually none of it is a credential. Taken
together it is a targeted map: named humans, their mailboxes, the exact app
registration that reaches their calendars, the hostname that serves it, and a
written statement of which parts of the deployment are unmigrated and
unprotected. That is phishing material and spam bait, published under the
maintainer's own name.

**Action:** move this file out of the repo entirely — it is deployment state, not
architecture. Put it where `deploy/.env` already lives (git-ignored) or in a
private ops repo, then **rewrite history** (`git filter-repo --path
docs/manual-todo.md --invert-paths`) before the repo goes public. Anything
genuinely architectural in it belongs in an ADR, written generically.

### 2. The same FQDN leaks from four other tracked files

- `docs/plans/household-stack-compose.md:205`
- `docs/plans/m365-integration.md:42`
- `docs/superpowers/plans/2026-07-29-deploy-household-stack.md:231, 868`
  (line 231 also carries the maintainer's Windows home directory)

`deploy/README.md:26` already shows the right pattern — it says
`heorth.home.example.com`. Apply that everywhere, in history too.

### 3. `Heorth/.claude/skills/run-local/SKILL.md`

Line 114 documents the local admin as the maintainer's personal email address,
and the same table hands out `postgres://kith:kithpw@localhost:55432/heorth_dev`
plus this machine's container names (`wyrhta-dev-heorth-1`, `kith-testdb`). The
password is worthless to anyone else, but the file describes one specific
person's laptop, in a repo about to become a public reference for self-hosters.
Generalise it; it is also in Heorth's history.

### 4. No repo has a LICENSE, and no `package.json` has a `license` field

Public without a licence means **all rights reserved**: nobody may legally run,
fork, or self-host any of it. For a project whose stated 1.0 gate is "ready for
other self-hosters", this is not a formality — it defeats the release. Pick one
(AGPL-3.0 if you want self-hosted forks to stay open, MIT/Apache-2.0 if you
don't) and add `LICENSE` plus the `license` field to all five code repos.

---

## Should fix — a stranger cannot get started

### 5. `@wyrhta/core` is a git dependency that builds on install

Per ADR 0010 the consumers pin `github:Wyrhta-Labs/wyrhta-core#v0.3.0` and core
builds itself via `prepare`. That works — core is already public, so an anonymous
HTTPS fetch resolves — but it means every consumer install needs `git`, a full
TypeScript toolchain, and a successful build of a *second* repo before `npm ci`
returns. The known cold-cache failure on Windows (`esbuild.exe ENOENT` inside the
`_cacache/tmp/git-clone…` path) is exactly the class of thing a first-time user
hits and cannot debug. Both consumer READMEs now state the requirement up front.

**Can core be hosted as a package on GitHub instead?** Yes — GitHub Packages has
an npm registry (`npm.pkg.github.com`) — but it does not solve this problem.
GitHub's own documentation is explicit: *"You need an access token to publish,
install, and delete private, internal, and **public** packages."* Unlike
`ghcr.io`, which serves public container images anonymously, the npm registry
requires every consumer to hold a personal access token and a `.npmrc`. For a
public self-hosted project that is strictly worse than today's git dependency,
which at least installs anonymously.

The two options that actually help, in order:

1. **Publish `@wyrhta/core` to npmjs.com** (`npm publish --access public`, needs
   the `wyrhta` scope registered there). Anonymous `npm ci`, no build on install,
   no git required — the normal experience. This is the real fix.
2. **Attach a tarball to each GitHub release.** `npm pack` in the release
   workflow, upload the `.tgz` as a release asset, and consumers pin
   `https://github.com/Wyrhta-Labs/wyrhta-core/releases/download/v0.3.0/wyrhta-core-0.3.0.tgz`.
   Anonymous, prebuilt, no registry account anywhere. Keeps everything inside
   GitHub, which is presumably what the question was after.

Either one supersedes part of ADR 0010 and deserves its own ADR rather than a
quiet change.

### 6. The `heorth-mcp` image is private, and package visibility is separate from repo visibility

`ghcr.io/wyrhta-labs/heorth-mcp` is private. Making the repo public does **not**
publish the package — `deploy/compose.prod.yml` will still fail with
`denied`/`unauthorized` for everyone but the maintainer. Flip the package to
public in its GHCR settings, then delete the "Registry login (required)" section
from `deploy/README.md` (lines 41–63), which currently tells a reader to
`docker login … -u cfoellmann`.

### 7. Heorth's `.env.example` and README publish unsafe defaults

- `CORS_ORIGIN=*` is presented as the value to copy, with no warning at the point
  of use. `deploy/.env.example` explains the risk properly; the repo-level one
  does not, and it is the file the README tells you to copy.
- `DATABASE_URL=postgres://heorth:changeme@localhost:5432/heorth` — port 5432 is
  a different project's cluster on the maintainer's machine, and the name is a
  primary database, not `_test`. `tests/setup.ts:10` carries the same stale
  default. Already recorded in `manual-todo.md` §6 as a real hazard: the test
  suite truncates every table.
- KithLedger's `.env.example` is the model to copy — placeholders, not values,
  and a generator command per secret.

### 8. Two competing ways to run each service

`Heorth/docker-compose.yml` and `KithLedger/docker-compose.yml` exist per repo,
while `deploy/compose.dev.yml` builds the same services from the meta repo. The
service READMEs point at the former, these docs at the latter. Say plainly in
each README which one is the supported path for an outsider and what the other is
for.

### 9. CI gaps that only become visible once strangers open PRs

- `wyrhta-core/.github/workflows/staging.yml` triggers on the **`staging`**
  branch only — but core develops on `main`. Core effectively has no CI, and a
  contributor's PR would get zero checks on the library everything else depends
  on.
- `KithLedger` and `heorth-mcp` have only `build-image.yml`. No test workflow at
  all; KithLedger has a full Vitest + Playwright suite that never runs in CI.
- `Heorth/.github/workflows/staging.yml` is the one that is right — `push` +
  `pull_request` on `main`, real Postgres service. Copy that shape into the other
  three.

### 10. No SECURITY.md, CONTRIBUTING.md, or issue templates anywhere

The website advertises `security@wyrhta.de`, but a person who finds a
vulnerability in a repo has nothing telling them where to send it. Add a
`SECURITY.md` per repo (or one in a `.github` org repo, which applies to all of
them), plus a short `CONTRIBUTING.md` stating the one-maker cadence so drive-by
PRs arrive with the right expectations.

---

## Worth knowing, not blocking

- **Commit author email.** Every commit in all six repos is authored with the
  maintainer's real address. Going public makes that permanently harvestable. If
  that is unwanted, switch to the GitHub `noreply` address going forward —
  changing the past means rewriting all six histories, which is only worth doing
  in the same pass as the fixes above.
- **`website` is boilerplate at the seams.** `package.json` name is
  `my-v0-project`, and the README is v0's template, linking a private v0 project
  and an "Open in Kiro" clone button. It is already public; it just reads as
  unowned.
- **Stale cross-references.** `heorth-mcp/README.md` calls the meta repo
  `Wyrhta-Labs/wyrhta-labs` (renamed to `wyrhta`). `CONTEXT.md` still says Feoh is
  "gated by `FEOH_ENABLED` (default off)" two sentences after saying it was
  merged — the switch was removed 2026-08-17. Docs link to `Wyrhta-Labs/Feoh`,
  which is private and archived: dead links for every public reader.
- **`docs/strategy.md:12`** — "The wife is the acceptance gate." Fine as internal
  doctrine; decide deliberately whether it reads that way to strangers.
- **Untracked but present in this checkout:** `deploy/.env` (live secrets) and
  `deploy/feoh-*.sql` (two real finance dumps). Both are correctly git-ignored and
  were never committed — verified against full history. Keep it that way; the
  `.gitignore` rules that protect them are `/deploy/.env*` and `/deploy/*.sql`.

---

## Before you flip the switch

1. Rewrite history for items 1–3 (`git filter-repo`) on all affected repos, then
   force-push. Do this while the repos are still private.
2. Add `LICENSE` to all five code repos.
3. Flip the `heorth-mcp` GHCR package to public alongside the repo.
4. Run a real scanner over each rewritten history —
   `gitleaks detect --no-git=false` or `trufflehog git file://.` — rather than
   trusting the pattern sweep behind this document.
5. Enable **secret scanning + push protection** and Dependabot alerts on every
   repo (Settings → Code security). They are free on public repos and would catch
   anything this sweep missed.
6. Only then flip visibility, one repo at a time, `wyrhta-core` last so its
   consumers are readable when someone follows the dependency.
