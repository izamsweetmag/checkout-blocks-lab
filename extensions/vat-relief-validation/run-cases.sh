#!/usr/bin/env bash
#
# Runs every case in test-inputs/ through the built function and checks the
# blocked/passed verdict against EXPECTED.tsv.
#
#   npm run cases            (from this directory)
#   ./run-cases.sh
#
# Needs Node >= 22.12 for the Shopify CLI. `shopify app function build` first if
# you have edited src/run.js — this runs dist/function.wasm, not the source.
set -uo pipefail
cd "$(dirname "$0")"

fail=0

while IFS=$'\t' read -r name expected; do
  [ -z "$name" ] && continue

  output=$(npm exec -- shopify app function run \
    --input "test-inputs/${name}.json" 2>&1)

  # function-runner prints the JSON result between "Output" and the resource
  # limits block. Counting the error messages is enough to tell blocked from
  # passed, and avoids depending on the exact framing it prints around them.
  count=$(printf '%s' "$output" \
    | sed -n '/Output/,/Resource Limits/p' \
    | grep -c 'localizedMessage')

  if [[ "$expected" == BLOCK* ]]; then
    want="blocked"
  else
    want="passed"
  fi
  if [ "$count" -gt 0 ]; then got="blocked"; else got="passed"; fi

  if [ "$want" = "$got" ]; then
    printf '  ok    %-36s %s\n' "$name" "$got"
  else
    printf '  FAIL  %-36s wanted %s, got %s\n' "$name" "$want" "$got"
    printf '%s\n' "$output" | sed -n '/Output/,/Resource Limits/p' | sed 's/^/        /'
    fail=1
  fi
done < test-inputs/EXPECTED.tsv

if [ "$fail" -eq 0 ]; then
  echo "  all cases behaved as expected"
fi
exit "$fail"
