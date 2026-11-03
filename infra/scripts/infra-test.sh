#!/bin/sh
# `@wg/infra`'s own suite, run DIRECTLY and never through `own-tmpdir.mjs`: this
# suite holds the wrapper's tests, and a commit touching only `infra/scripts/*`
# inherits a gate that runs exactly this suite — so a wrapper that lost exit
# codes would pass its own failing tests (cold review of 02ce616). It gets a
# temp folder of its own all the same (vitest leaves `<nanoid>/{ssr,client}`
# in whatever `TMPDIR` is), removed whatever the run did. Arguments pass
# through to vitest, so `pnpm --filter @wg/infra run test -- own-tmpdir` runs
# one file (the re-review of 1401b61: a trailing `exit` in the package script
# swallowed them).
# pnpm 10 hands a `--` through as it was typed; vitest would read the filter
# after it as no filter at all.
if [ "${1:-}" = "--" ]; then shift; fi
[ "${1:-}" = related ] || set -- run "$@"
dir=$(mktemp -d "${TMPDIR:-/tmp}/wg-infra-test-XXXXXX") || exit 1
TMPDIR=$dir TMP=$dir TEMP=$dir vitest "$@"
status=$?
rm -rf "$dir"
exit "$status"
