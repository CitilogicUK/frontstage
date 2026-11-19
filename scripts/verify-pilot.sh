#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

image="${1:-frontstage:pilot}"
yarn verify:code
yarn build:all
docker build -f packages/backend/Dockerfile -t "$image" .
yarn test:pilot-image "$image"
yarn test:pilot-compose "$image"
