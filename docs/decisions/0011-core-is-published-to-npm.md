# 0011 — `@wyrhta/core` is published to npm

**Status:** accepted 2026-08-19 · **Amends [0010](0010-core-stays-a-git-dependency-that-builds-on-install.md).**
0010's finding stands and is not reversed; its *conclusion* is narrowed — see
"Relationship to 0010" below.

## Context

ADR 0010 concluded that the git-tag dependency
(`"@wyrhta/core": "github:Wyrhta-Labs/wyrhta-core#v0.3.0"`) was fine, because
the specific threat it was investigating — npm 11's `allowScripts` policy
silently installing core unbuilt — did not exist. That measurement was correct
and nothing here disputes it.

What changed is the audience. On 2026-08-19 every Wyrhta Labs repo became
public. The git dependency was evaluated against one question — *does it break?*
— and never against the one that now matters: *what does it cost a stranger?*
For a first-time reader, the answer is:

- `npm install` needs **git on the PATH** and a working TypeScript toolchain,
  because core compiles itself during install.
- It clones and builds a **second repository** before the first one finishes
  installing, so a first install is slow and its failures surface as errors
  inside someone else's package.
- On a cold *global* npm cache on Windows it **fails outright**, inside core's
  git clone, with `spawnSync .../_cacache/tmp/git-clone.../esbuild.exe ENOENT`
  — most likely the long `_cacache/tmp/git-clone*` path. Container builds are
  unaffected, so this never showed up in CI or in deployment.
- Nothing standard works on it: no semver ranges, no `npm audit` metadata, no
  Dependabot or Renovate updates, no provenance.

That last group is the real cost. A pinned git tag is not a version to any tool
in the ecosystem; it is a URL.

**GitHub Packages was considered and rejected.** It has an npm registry
(`npm.pkg.github.com`), and keeping distribution inside GitHub is superficially
attractive. But GitHub's own documentation is explicit: *"You need an access
token to publish, install, and delete private, internal, and **public**
packages."* Unlike `ghcr.io`, which serves public images anonymously, its npm
registry has **no anonymous read at all**. Every consumer would need a personal
access token and an `.npmrc` — strictly worse than the git dependency, which at
least installs without credentials. It solves nothing here.

## Decision

**`@wyrhta/core` is published to npmjs.com as a public scoped package, via npm
trusted publishing from GitHub Actions.**

1. **Trusted publishing, not a token.** `.github/workflows/publish.yml` in
   `wyrhta-core` triggers on a `v*` tag and authenticates to npm over **OIDC**
   (`permissions: id-token: write`). There is **no `NPM_TOKEN` secret** in the
   repo — nothing to leak, nothing to rotate, nothing that keeps working if it
   is stolen. npm attaches a **provenance attestation** automatically, so a
   consumer can verify which workflow, in which repo, at which commit, produced
   the tarball. For a public supply-chain dependency that is the point.
2. **The tag is the trigger and the source of truth.** The workflow refuses to
   publish when the git tag disagrees with `package.json`'s version, and runs
   typecheck, tests, and build before publishing. Core is consumed by pin, and
   there is no clean unpublish path, so a bad tag must fail in CI rather than in
   a consumer's install.
3. **Consumers move to a semver range** — `"@wyrhta/core": "^0.3.0"` — once the
   first version is published. They stop needing git, stop building a second
   repo at install time, and start receiving Dependabot updates.
4. **The git dependency remains valid** as a fallback and for unreleased work:
   pinning a commit or a branch of `wyrhta-core` still works and is the right
   tool for testing an unpublished change against a consumer before cutting a
   tag.

## Relationship to 0010

0010 asked "is the git dependency broken?" and correctly answered no. This ADR
asks "is it the right way to *distribute* a public library?" and answers no for
different reasons — ergonomics, tooling, and supply-chain verifiability, none of
which 0010 examined. Its measurements about `allowScripts` remain accurate and
are worth keeping: they are why core's `prepare` script is *not* a hazard, which
is what makes the fallback in point 4 safe to keep using.

The part of 0010 that is superseded is its title claim — core does not *stay* a
git dependency as its published form.

## Consequences

- **A manual step exists and gates everything else.** The `@wyrhta` scope must be
  registered on npmjs.com, and the trusted publisher (organisation, repository,
  and the workflow filename `publish.yml`) registered in the package's settings
  there. Until that is done the workflow will run and fail at the publish step.
  The first publish of a brand-new scoped package may need one manual
  `npm publish --access public`, because a trusted publisher cannot be
  configured for a package that does not exist yet.
- **Pre-1.0 semantics are unchanged** and still need saying out loud, because a
  `^` range now means npm will take upgrades on its own: minor versions may
  break, patch versions are safe. `^0.3.0` resolves only within `0.3.x`, which
  matches that promise — but the release discipline from `strategy.md` (semver
  tag plus changelog entry per change) is now load-bearing rather than
  courteous.
- **Two publication surfaces per release.** A tag both publishes to npm and, for
  the services, builds a container image. They can now disagree; the version
  guard in the workflow is what keeps the npm side honest.
- **The consumers' pins are not yet switched.** They stay on the git tag until a
  version actually exists on npm, so nothing depends on a package that has not
  been published. That switch is a separate, deliberate commit in each consumer
  repo.
