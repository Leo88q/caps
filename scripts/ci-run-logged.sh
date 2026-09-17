#!/bin/sh
# ci-run-logged.sh <log-path> <command> [args…] — run a CI command, keep its exit code, and leave its
# whole output in a file that `ci-surface-log.sh` can publish if it failed.
#
# POSIX-only on purpose, and that is the entire reason this file exists. The first version of these steps
# was `set -o pipefail; cmd 2>&1 | tee /tmp/x.log`, which is bash. A `container:` job's default shell is
# `/bin/sh` — dash in the anchor image — where `set -o pipefail` is an illegal option: the step exited 2
# at line 1, `anchor build` never started, `/tmp/anchor-build.log` was never created, and the run's only
# evidence was "Process completed with exit code 2." A capture mechanism must be portable or it silently
# becomes the failure it was supposed to explain.
#
# No pipe either: `cmd | tee log` reports tee's exit status, so a red cargo looks green unless pipefail is
# in force — and pipefail is exactly what this script cannot use. Redirection plus an explicit `exit $code`
# gets both properties at once. The log is echoed afterwards so the step stays readable live.
log=$1
shift
if [ -z "$log" ] || [ "$#" -eq 0 ]; then
  echo "usage: $0 <log-path> <command> [args…]" >&2
  exit 2
fi
mkdir -p "$(dirname "$log")" 2>/dev/null || true
"$@" > "$log" 2>&1
code=$?
if command -v tee >/dev/null 2>&1; then
  tee < "$log"
else
  cat "$log"
fi
exit "$code"
