---
title: Wyrhta Labs
status: aktiv
next-id: 3
---

# Wyrhta Labs — TODOs

## Gewrit v1 (ADR 0017)

- [ ] Check the Gewrit PDF preview renders in Chrome and Firefox before tagging Heorth v0.9.0 prio:hoch id:1
  The spec's security model rests on an unsandboxed `blob:` iframe rendering the PDF;
  the server half (headers, allowlist, valid PDF) was verified over HTTP, the browser
  half was not.
  1. From the meta repo root, bring the demo up: `deploy/demo-up.sh --fresh`
     (it pins `GEWRIT_PROVIDER: fake` and seeds four document links).
  2. Log in on http://localhost:24000 as a demo adult (logins: `.agents/skills/wyrhta-demo/SKILL.md`).
  3. Open the Vaillant ecoTEC boiler asset → Documents → the operating manual.
  4. Confirm the generated PDF shows **inside** the dialog, in Chrome and in Firefox.
  If a browser refuses to render it, do not add a `sandbox` attribute or a CSP as a
  workaround — that is a design question (Heorth `AGENTS.md`, Gewrit rules).

- [ ] Check the household's Paperless-ngx answers API version 10 before enabling GEWRIT_PROVIDER=paperless prio:mittel id:2
  Heorth pins `PAPERLESS_API_VERSION = 10`; an older Paperless answers `406`, which
  shows as "Paperless is unavailable". Put `PAPERLESS_BASE_URL` and `PAPERLESS_TOKEN`
  (the dedicated `heorth` user, see the Heorth README "Setting up Paperless for Heorth")
  into `deploy/.env`, then:
  ```bash
  curl -s -o /dev/null -D - -H "Authorization: Token $PAPERLESS_TOKEN" \
    -H "Accept: application/json; version=10" \
    "$PAPERLESS_BASE_URL/api/documents/?page_size=1" | grep -i -E '^(HTTP|x-api-version)'
  ```
  Expected: `HTTP/... 200` and `X-Api-Version: 10`. On `406`, upgrade Paperless or
  decide deliberately to pin lower — never lower the constant silently.
