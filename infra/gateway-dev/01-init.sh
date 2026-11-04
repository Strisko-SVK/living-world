#!/bin/sh
# Executes only during initialization of a NEW dedicated DEV Postgres volume.
set -eu
: "${LW_GATEWAY_DEV_ROLE_PASSWORD:?Missing DEV role password}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v "dev_password=$LW_GATEWAY_DEV_ROLE_PASSWORD" <<'SQL'
CREATE ROLE lw_gateway_dev LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'dev_password';
CREATE DATABASE living_world_gateway_dev OWNER lw_gateway_dev;
SQL
