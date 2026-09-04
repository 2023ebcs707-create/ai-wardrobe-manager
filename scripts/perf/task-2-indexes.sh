#!/bin/sh
# Runs the Claim 7 live index verification.
#
# It must run from `apps/api` under `ts-node/register`, because the index set
# has to come from the product's OWN TypeScript models rather than from
# anything the harness could declare for itself -- see the header of
# task-2-indexes.js. pnpm's strict node_modules layout means `mongoose` and
# `@wardrobe/shared` only resolve from inside that package.
set -e
cd "$(dirname "$0")/../../apps/api"
exec node --require ts-node/register ../../scripts/perf/task-2-indexes.js "$@"
