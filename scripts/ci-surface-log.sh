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
#     otherwise eat the text (`:` and `%` in workflow commands, YAML block scalars, the annotation parser),
#     and the chunk is capped because a check-run annotation message is truncated at 4096 characters — a
#     cut base64 blob decodes to "Incorrect padding" and to nothing else.
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
  grep -nE '^[[:space:]]*--> [^ ]+:[0-9]+:[0-9]+' "$log" 2>/dev/null | head -8 |
    while IFS=: read -r lineno _ _ path rest; do
      msg=$(sed -n "$((lineno - 1))p" "$log" 2>/dev/null | sed 's/^[[:space:]]*//' | cut -c1-180 || true)
      printf '::error file=%s,line=%s,title=%s::%s\n' "$path" "${rest%%:*}" "$name" "$(esc "$msg")" || true
    done

  for side in head tail; do
    b64=$($side -c 9000 "$log" 2>/dev/null | base64 -w0 2>/dev/null || $side -c 9000 "$log" 2>/dev/null | base64 | tr -d '\n' || true)
    total=$(printf '%s' "$b64" | wc -c | tr -d ' ')
    off=1
    i=0
    while [ -n "$b64" ] && [ "$off" -le "$total" ] && [ "$i" -lt 8 ]; do
      i=$((i + 1))
      chunk=$(printf '%s' "$b64" | cut -c"$off"-"$((off + 3200))" || true)
      [ -n "$chunk" ] || break
      printf '::error title=%s-%s[%s],file=.github/workflows/ci.yml,line=1::log64:%s\n' "$name" "$side" "$i" "$chunk"
      off=$((off + 3200))
    done
  done

  {
    printf '### %s — last 4000 bytes of the log\n\n```\n' "$name"
    tail -c 4000 "$log" 2>/dev/null || true
    printf '```\n\n'
  } >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
done
exit 0
