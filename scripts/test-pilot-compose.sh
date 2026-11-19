#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

export FRONTSTAGE_PILOT_IMAGE="${1:-frontstage:pilot}"
export FRONTSTAGE_PILOT_PORT="${FRONTSTAGE_COMPOSE_SMOKE_PORT:-7313}"
export FRONTSTAGE_PILOT_IDENTITY_CONFIG=./examples/pilot-identity-config.yaml
export FRONTSTAGE_PILOT_IDENTITIES=./examples/pilot-identities.yaml
export FRONTSTAGE_GITHUB_CLIENT_ID=frontstage-compose-smoke
export FRONTSTAGE_PILOT_POSTGRES_ADMIN_PASSWORD="$(openssl rand -hex 24)"
export FRONTSTAGE_PILOT_DB_PASSWORD="$(openssl rand -hex 24)"
export FRONTSTAGE_GITHUB_CLIENT_SECRET="$(openssl rand -hex 24)"
project=frontstage-compose-smoke-$(openssl rand -hex 8)

compose() {
  docker compose -p "$project" -f compose.pilot.yaml "$@"
}

query() {
  compose exec -T postgres psql -U postgres -d frontstage -Atq \
    -v ON_ERROR_STOP=1 -c "$1"
}

assert_equal() {
  if [ "$1" != "$2" ]; then
    echo "$3" >&2
    exit 1
  fi
}

cleanup() {
  compose down --volumes
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker image inspect "$FRONTSTAGE_PILOT_IMAGE" >/dev/null
compose up --detach --wait --wait-timeout 90
original_database=$(compose ps -q postgres)
test -n "$original_database"
query "INSERT INTO governance.governance_tier_one_registration_timing (utc_day, elapsed_seconds) VALUES ('2025-01-01', 42)"

# Removing the containers without removing the named volume tests persistence.
compose down
compose up --detach --wait --wait-timeout 90
recreated_database=$(compose ps -q postgres)
test -n "$recreated_database"
test "$original_database" != "$recreated_database"
assert_equal "$(query "SELECT elapsed_seconds FROM governance.governance_tier_one_registration_timing WHERE utc_day = '2025-01-01'")" 42 \
  'The Compose timing sample did not survive container recreation.'
assert_equal "$(query "SELECT count(*) FROM catalog.final_entities WHERE entity_ref IN ('user:default/pilot-builder', 'user:default/pilot-reviewer')")" 2 \
  'The recreated Compose stack is missing pilot Catalog identities.'
assert_equal "$(query "SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication) FROM pg_roles WHERE rolname = 'frontstage'")" t \
  'The Compose database role does not have the expected restrictions.'
origin="http://127.0.0.1:$FRONTSTAGE_PILOT_PORT"
assert_equal "$(curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' "$origin/.backstage/health/v1/readiness")" 200 \
  'The recreated Compose stack did not become ready on its host port.'
assert_equal "$(curl --silent --max-time 10 --output /dev/null --write-out '%{http_code}' "$origin/api/governance/apps")" 401 \
  'The recreated Compose stack did not reject anonymous Inventory access.'

echo 'Pilot Compose stack passed container recreation, database persistence, restricted database roles, and API access checks.'
