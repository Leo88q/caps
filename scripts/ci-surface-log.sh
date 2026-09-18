#!/bin/sh
# ci-surface-log.sh <log-path>… — turn a captured CI log into evidence you can read from the outside.
#
# Why this exists at all: the runner's log host is unreachable from a terminal (`gh api
# …/actions/jobs/<id>/logs` returns an empty reply — the blob host EOFs, and `curl` cannot reach it
# either), so the annotations GitHub publishes are the only thing that survives the trip, and by default
# they carry only "Process completed with exit code 101." That is not a diagnosis: the 101 turned out to be
# cargo's "no such command" for clippy, not 40 lints, and a later exit 2 was this file's own predecessor (a
# bashism in a dash container) rather than anything `anchor build` did.
#
# Shape, and the constraint behind each piece:
#   * an annotation per `--> path:line:col`, paired with the message line above it, so the failure shows up
#     on the file in the diff view. `grep`/`sed`, not `awk`: the runner ships mawk, which reads
#     `if (a[1] /re$/)` as a division and dies with exit 2 — a reporting step that fails buries the report.
#   * base64 head/tail of the log in the message body, in chunks. base64 survives every layer that would
#     otherwise eat the text (`:` and `%` in workflow commands, YAML block scalars, the annotation parser).
#     The chunk size is a measured constant, not a guess: the API truncates an annotation *message* at 3201
#     characters, so `log64:` (6) plus a 3200-char chunk (cut inclusively to 3201) lost exactly six
#     characters in run 46 — 3201 base64 chars is 1 mod 4, so every chunk decoded to "cannot be 1 more
#     than a multiple of 4" and the evidence was gone. 3000 chars per chunk leaves 295 of slack; 2250 raw
#     bytes each, up to 12 chunks per side = ~27 KB, which is more than these logs are; the count is then
#     cut by however many diagnostics were emitted, because Actions keeps ~50 annotations per check run and
#     drops the overflow silently.
#   * errors before warnings in the file-level slots. Run 4's first eight `-->` lines were four `warning:
#     unexpected cfg` in a file that compiled fine, and the error that actually failed the job was below
#     them and invisible. The slot budget goes to `^error` first.
#   * a missing or empty log is itself an error annotation. Silence was ambiguous — "the command produced
#     nothing" vs "capture never ran" — and the second case is what hid two separate failures.
#   * the tail also goes to $GITHUB_STEP_SUMMARY, where there is no 4096-char budget.
#
# This step must never fail: it runs under `if: failure()`. Everything non-printing is `|| true` and the
# exit is unconditional.
set -u

# In a message only `%` needs escaping — unlike `key=value` properties, `::` is not a delimiter here, and
# escaping it would show the reader `%3A%3A`.
esc() { printf '%s' "$1" | tr '\n\r' '  ' | sed 's/%/%25/g'; }

for log in "$@"; do
  name=$(basename "$log" .log)
  if [ ! -s "$log" ]; then
    printf '::error title=%s: no log captured,file=.github/workflows/ci.yml,line=1::nothing wrote %s, so the step died before running the command (shell incompatibility in this container, or the tool is not installed) — and every step below it in the job was skipped.\n' "$name" "$log"
    continue
  fi

  # rustc writes `--> path:line:col` directly under the message; pairing them makes the failure clickable.
  # The triple is produced by sed, not by `IFS=:` over grep's own `N:` prefix — the first version read the
  # line number out of the wrong field and emitted `file=5,line=`, i.e. an annotation on nothing.
  #
  # Errors get their own pass first, walking *down* from `^error` to the `-->` under it: taking the eight
  # first `-->` lines in file order showed warnings only, and the failure sat below them. `error[E0277]`,
  # bare `error:` and cargo's own `error: could not compile` all match; a `note:` never does, because a
  # note is what the compiler says while explaining somebody else's error.
  emitted=0
  grep -nE '^error(\[[^]]*\])?:' "$log" 2>/dev/null | head -8 | cut -d: -f1 | tee /tmp/.surface-errors.$name.$$ |
    while read -r eno; do
      [ -n "$eno" ] || continue
      # the `-->` may be up to 5 lines below (a diagnostic can carry a few note lines before it); if no
      # `-->` follows at all, the error is cargo's own ("could not compile", "failed to parse manifest")
      # and there is no file to point at — say which line of the log it is on instead of pointing nowhere.
      arrow=$(sed -n "$((eno + 1)),$((eno + 6))p" "$log" 2>/dev/null |
        grep -m1 -E '^[[:space:]]*--> [^ ]+:[0-9]+(:[0-9]+)?' || true)
      msg=$(sed -n "${eno}p" "$log" 2>/dev/null | sed 's/^[[:space:]]*//' | cut -c1-200 || true)
      if [ -n "$arrow" ]; then
        set -- $(printf '%s' "$arrow" | sed -E 's/.*-->[[:space:]]*([^:]+):([0-9]+).*/\1 \2/')
        printf '::error file=%s,line=%s,title=%s:%s::%s\n' "$1" "$2" "$name" "$eno" "$(esc "$msg")" || true
      else
        printf '::error file=.github/workflows/ci.yml,line=%s,title=%s:%s::%s\n' "$eno" "$name" "$eno" "$(esc "$msg")" || true
      fi
    done
  grep -nE '^[[:space:]]*--> [^ ]+:[0-9]+:[0-9]+' "$log" 2>/dev/null | head -4 |
    sed -E 's/^([0-9]+):[[:space:]]*-->[[:space:]]*([^:]+):([0-9]+):([0-9]+).*$/\1 \2 \3/' |
    while read -r lineno path ln; do
      [ -n "$path" ] || continue
      msg=$(sed -n "$((lineno - 1))p" "$log" 2>/dev/null | sed 's/^[[:space:]]*//' | cut -c1-180 || true)
      printf '::error file=%s,line=%s,title=%s::%s\n' "$path" "$ln" "$name" "$(esc "$msg")" || true
    done

  # Actions keeps at most ~50 annotations per check run and silently drops the rest, so the windows are
  # sized by what is left after the diagnostics: two logs in one step (a build wrapper that surfaces a
  # cargo log and a script log) must not silently push the second one off the list.
  errors=$(wc -l < /tmp/.surface-errors.$name.$$ 2>/dev/null | tr -d ' ' || echo 0)
  [ -n "$errors" ] || errors=0
  rm -f /tmp/.surface-errors.$name.$$ 2>/dev/null || true
  # …and shared across the logs of one step: `rust-lints` surfaces clippy and cargo-test together, and two
  # full-size windows would put the second log's chunks past the limit — where they are dropped, not shown
  # as truncated.
  budget=$(( (44 - errors) / 2 / $# ))
  [ "$budget" -gt 12 ] && budget=12
  [ "$budget" -lt 1 ] && budget=1
  per_side=$((budget * 2250))
  for side in head tail; do
    b64=$($side -c "$per_side" "$log" 2>/dev/null | base64 -w0 2>/dev/null || $side -c 27000 "$log" 2>/dev/null | base64 | tr -d '\n' || true)
    total=$(printf '%s' "$b64" | wc -c | tr -d ' ')
    off=1
    i=0
    while [ -n "$b64" ] && [ "$off" -le "$total" ] && [ "$i" -lt "$budget" ]; do
      i=$((i + 1))
      # `cut -c A-B` is inclusive on both ends: the chunk is 3000 chars, not 3001, and every char of slack
      # below the API's 3201 is a guard against the prefix length changing (see the header).
      chunk=$(printf '%s' "$b64" | cut -c"$off"-$((off + 2999)) || true)
      [ -n "$chunk" ] || break
      printf '::error title=%s-%s[%s],file=.github/workflows/ci.yml,line=1::log64:%s\n' "$name" "$side" "$i" "$chunk"
      off=$((off + 3000))
    done
  done

  # The summary is for a human on the job page, so it leads with the diagnostics rather than the tail —
  # the tail of a cargo log is usually `Compiling` lines of crates that succeeded.
  {
    printf '### %s — errors\n\n```\n' "$name"
    grep -E '^error(\[[^]]*\])?:' -A6 "$log" 2>/dev/null | head -120 || printf '(no ^error line: the command exited non-zero without printing one — see the log window below)\n'
    printf '```\n\n### %s — last 4000 bytes\n\n```\n' "$name"
    tail -c 4000 "$log" 2>/dev/null || true
    printf '```\n\n'
  } >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
done
exit 0
