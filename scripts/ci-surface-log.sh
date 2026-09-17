#!/usr/bin/env bash
# Publish a failed Rust step's log as annotations, because the log itself is not always reachable.
#
# A GitHub runner serves its logs from `productionresultssa*.blob.core.windows.net`. That host answers `EOF`
# to anything without a browser — a sandbox, a curl in a firewall, a script triaging a red run — and the
# check-run annotation for a whole failed `cargo` invocation is "Process completed with exit code 101". The
# diagnosis that leaves is the exit code, which is not a diagnosis: it does not separate "the code has 40
# lints" from "this image has no clippy", and the second one was live in this repo for weeks (see below).
#
# So each Rust job ends with `if: failure()` → `bash scripts/ci-surface-log.sh <logs…>`, which emits:
#   1. rustc's own error/warning lines as real file/line annotations (max 8 — a UI with 8 links is readable,
#      a UI with 200 is a wall), for whoever clicks through;
#   2. the log itself, head and tail, base64-encoded, in the annotation *message*, for whoever reads the API:
#      the workflow-command parser owns `%` and the message terminator, so an escaped-once blob is the only
#      thing that survives verbatim (decode: `… | base64 -d`);
#   3. the tail as text in the step summary, for the human.
#
# This script never fails. A surfacing step that can itself go red would mask the failure it exists to
# report, which is a worse version of the problem it fixes — hence the `|| true` on everything that is not
# formatting an annotation, and the unconditional `exit 0`.
set -u

MAX_ANNOTATIONS=8

for log in "$@"; do
  [ -s "$log" ] || continue
  name="$(basename "$log" .log)"

  # 1. `--> path:line:col` lines are rustc's own locations; the message is the line above them. grep+sed
  # because the awk in these images is mawk, and mawk reads `x /(re)/` as a division.
  grep -n '^[[:space:]]*--> ' "$log" 2>/dev/null | head -n "$MAX_ANNOTATIONS" | while IFS= read -r hit; do
    lineno="${hit%%:*}"
    rest="${hit#*-->}"
    rest="${rest# }"
    file="${rest%%:*}"
    line="${rest#*:}"
    line="${line%%:*}"
    case "$file" in *.rs | *.toml) ;; *) continue ;; esac
    msg="$(sed -n "$((lineno > 1 ? lineno - 1 : 1))p" "$log" 2>/dev/null | tr -d '\r' | sed 's/%/%25/g')"
    case "$msg" in
    "") msg="$name: see $file:$line" ;;
    esac
    printf '::error file=%s,line=%s,title=%s::%s\n' "$file" "$line" "$name" "$msg"
  done || true

  # 2. the raw log, twice: what the compiler decided first, and what it concluded last
  head64="$(head -c 12000 "$log" 2>/dev/null | base64 -w0 2>/dev/null || head -c 12000 "$log" | base64 | tr -d '\n')" || true
  tail64="$(tail -c 12000 "$log" 2>/dev/null | base64 -w0 2>/dev/null || tail -c 12000 "$log" | base64 | tr -d '\n')" || true
  [ -n "${head64:-}" ] && printf '::error title=%s-head,file=.github/workflows/ci.yml,line=1::log64:%s\n' "$name" "$head64"
  [ -n "${tail64:-}" ] && printf '::error title=%s-tail,file=.github/workflows/ci.yml,line=1::log64:%s\n' "$name" "$tail64"

  # 3. the same tail, readable
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### ${name} — last 4000 bytes of the log"
      echo
      echo '```'
      tail -c 4000 "$log" 2>/dev/null
      echo '```'
    } >>"$GITHUB_STEP_SUMMARY" || true
  fi
done

exit 0
