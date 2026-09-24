---
title: Wyrhta Labs
status: aktiv
next-id: 3
---

# Wyrhta Labs — TODOs

## Gewrit v1 (ADR 0017)

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
