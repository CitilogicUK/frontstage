#!/bin/sh
set -eu

# The app connects with a URL, so use characters that need no URL escaping.
case ${FRONTSTAGE_PILOT_DB_PASSWORD:?Set the Frontstage database password} in
  *[!A-Za-z0-9._~-]*)
    echo 'Use a URL-safe Frontstage database password, such as a random hex string.' >&2
    exit 1
    ;;
esac

psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 \
  --set frontstage_password="$FRONTSTAGE_PILOT_DB_PASSWORD" <<'SQL'
CREATE ROLE frontstage LOGIN PASSWORD :'frontstage_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE frontstage OWNER frontstage;
SQL
