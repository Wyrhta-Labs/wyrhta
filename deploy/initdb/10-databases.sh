#!/bin/sh
# Provisions the household roles and databases in a cluster.
#
# RUNS ONCE, AND ONLY WHEN THE DATA DIRECTORY IS EMPTY. docker-entrypoint-initdb.d
# is skipped entirely on an existing volume. Adding another service to a live
# cluster is a manual psql step — see deploy/README.md.
#
# Every compose file mounts this one script; three switches pick which
# databases a cluster gets. The roles are always created.
#
#   CREATE_PRIMARY_DATABASES  default true   heorth, kithledger (+ firefly)
#   CREATE_DEV_DATABASES      default false  heorth_dev, kithledger_dev (+ firefly_dev)
#   CREATE_TEST_DATABASES     default false  heorth_test, kithledger_test
#
# prod and demo use the defaults. compose.dev.yml's `db` adds the *_dev set;
# its `db-test` turns the primary set off and the *_test set on, so the test
# suites' per-test truncation runs in a separate, disposable cluster and never
# shares a checkpointer with dev data.
set -eu

create_role() {
  role="$1"
  pw="$2"

  if [ -z "$pw" ]; then
    echo "initdb: refusing to create role '$role' with an empty password" >&2
    exit 1
  fi

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE ROLE "$role" LOGIN PASSWORD '$pw';
	EOSQL
  echo "initdb: created role '$role'"
}

create_db() {
  db="$1"
  owner="$2"

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE DATABASE "$db" OWNER "$owner";
	REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
	EOSQL
  echo "initdb: created database '$db' owned by '$owner'"
}

create_role heorth     "${HEORTH_DB_PASSWORD:-}"
create_role kithledger "${KITH_DB_PASSWORD:-}"

if [ "${CREATE_PRIMARY_DATABASES:-true}" = "true" ]; then
  create_db heorth     heorth
  create_db kithledger kithledger
fi

# Dev only: the dev services run against *_dev, because the suites' guard
# refuses any database that does not end in _test — naming dev data *_dev is
# what keeps a stray `npm test` off it (the incident recorded at
# docs/manual-todo.md).
if [ "${CREATE_DEV_DATABASES:-false}" = "true" ]; then
  create_db heorth_dev     heorth
  create_db kithledger_dev kithledger
fi

# Test cluster only (compose.dev.yml `db-test`): the suites TRUNCATE every table
# between tests. They used to live beside the dev data, and that churn drove
# checkpoints long enough to time tests out.
if [ "${CREATE_TEST_DATABASES:-false}" = "true" ]; then
  create_db heorth_test     heorth
  create_db kithledger_test kithledger
fi

# Firefly III, the bank-ingestion sidecar (ADR 0016). GUARDED ON A NON-EMPTY
# PASSWORD, not on a stack name: compose.demo.yml and the dev `db-test` mount
# this same directory and run no Firefly, so an unconditional call here would
# abort those clusters on the empty-password check above. Blank means "this
# stack has no Firefly" and is a skip, not an error.
if [ -n "${FIREFLY_DB_PASSWORD:-}" ]; then
  create_role firefly "${FIREFLY_DB_PASSWORD}"
  if [ "${CREATE_PRIMARY_DATABASES:-true}" = "true" ]; then
    create_db firefly firefly
  fi
  if [ "${CREATE_DEV_DATABASES:-false}" = "true" ]; then
    create_db firefly_dev firefly
  fi
else
  echo "initdb: FIREFLY_DB_PASSWORD is empty — skipping the firefly role and databases"
fi
