#!/bin/sh
# Provisions the household databases in the shared cluster.
#
# RUNS ONCE, AND ONLY WHEN THE DATA DIRECTORY IS EMPTY. docker-entrypoint-initdb.d
# is skipped entirely on an existing volume. Adding another service to a live
# cluster is a manual psql step — see deploy/README.md.
set -eu

create_owned_db() {
  role="$1"
  db="$2"
  pw="$3"

  if [ -z "$pw" ]; then
    echo "initdb: refusing to create role '$role' with an empty password" >&2
    exit 1
  fi

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE ROLE "$role" LOGIN PASSWORD '$pw';
	CREATE DATABASE "$db" OWNER "$role";
	REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
	EOSQL
  echo "initdb: created database '$db' owned by '$role'"
}

create_owned_db heorth     heorth     "${HEORTH_DB_PASSWORD:-}"
create_owned_db kithledger kithledger "${KITH_DB_PASSWORD:-}"

# Dev only: separate databases for the test suites, so per-test truncation can
# never wipe dev data (the incident recorded at docs/manual-todo.md).
if [ "${CREATE_TEST_DATABASES:-false}" = "true" ]; then
  for pair in "heorth:heorth_test" "kithledger:kithledger_test" "heorth:heorth_dev" "kithledger:kithledger_dev"; do
    role="${pair%%:*}"
    db="${pair##*:}"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE DATABASE "$db" OWNER "$role";
	REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
	EOSQL
    echo "initdb: created database '$db'"
  done
fi

# Firefly III, the bank-ingestion sidecar (ADR 0016). GUARDED ON A NON-EMPTY
# PASSWORD, not on a stack name: compose.demo.yml mounts this same directory and
# runs no Firefly, so an unconditional call here would abort the whole demo
# cluster on the empty-password check above. Blank means "this stack has no
# Firefly" and is a skip, not an error.
if [ -n "${FIREFLY_DB_PASSWORD:-}" ]; then
  create_owned_db firefly firefly "${FIREFLY_DB_PASSWORD}"
  if [ "${CREATE_TEST_DATABASES:-false}" = "true" ]; then
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE DATABASE "firefly_dev" OWNER "firefly";
	REVOKE ALL ON DATABASE "firefly_dev" FROM PUBLIC;
	EOSQL
    echo "initdb: created database 'firefly_dev'"
  fi
else
  echo "initdb: FIREFLY_DB_PASSWORD is empty — skipping the firefly role and databases"
fi
