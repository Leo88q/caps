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
#   * one annotation per *distinct* diagnostic, carrying the whole block (message, `-->` position, the
#     `= note:` lines) with newlines as %0A. A fixer needs the "expected …, found …" sentence, not the fact
#     that a line started with `error`. Distinct-by-message matters because `cargo check --all-targets`
#     reports the same error once per target and the eight-slot budget would be spent on duplicates.
#   * `file=`/`line=` point at the `-->` path under the error when there is one, and at the *log line* when
#     there is not — cargo's own errors ("could not compile", "failed to parse manifest") have no source
#     position, and an annotation on nothing is worse than one that says which line to look near.
#   * base64 head/tail of the log in the message body, in chunks, as the fallback for anything the error
#     grep did not match (a build that dies on a signal, a panic, a script bug). base64 survives every layer
#     that would otherwise eat the text (`:` and `%` in workflow commands, YAML block scalars, the annotation
#     parser). The chunk size is a measured constant: the API truncates an annotation *message* at 3201
#     characters, so `log64:` (6) plus a 3200-char chunk (cut inclusively to 3201) lost exactly six
#     characters in run 46 — 3201 base64 chars is 1 mod 4, and every chunk then decoded to "cannot be 1 more
#     than a multiple of 4". 3000 chars per chunk leaves 295 of slack; 2250 raw bytes each.
#   * the chunk count is *budgeted* against the annotation ceiling (Actions keeps ~50 per check run and
#     drops the overflow silently), shared across the logs one step surfaces at once, and the accounting is
#     printed as a notice — a report that silently reports nothing needs to say what it decided. Run 47 is
#     the reason: its `cargo-lock` job produced 0 window chunks and no way to see why.
#   * a missing or empty log is itself an error annotation. Silence was ambiguous — "the command produced
#     nothing" vs "capture never ran" — and the second case is what hid two separate failures.
#   * the error blocks and the tail also go to $GITHUB_STEP_SUMMARY, where there is no 3201-char budget.
#
# This step must never fail: it runs under `if: failure()`. Everything non-printing is `|| true` and the
# exit is unconditional.
set -u

# How many logs this step surfaced, read once up front: `set --` below (and `for log in "$@"`) would
# otherwise rewrite the positional parameters mid-run, and `$#` was the divisor in the window budget — a
# report whose window count depends on which branch ran last is how run 47's cargo-lock job ended up with
# zero log chunks and no way to see why.
nlogs=$#

# In a message only `%` needs escaping — unlike `key=value` properties, `::` is not a delimiter here, and
# escaping it would show the reader `%3A%3A`. Newlines become the `%0A` escape GitHub decodes back.
esc() { printf '%s' "$1" | tr -d '\r' | tr '\n' ' ' | sed 's/%/%25/g'; }
escnl() {
  printf '%s' "$1" | tr -d '\r' | sed -e 's/%/%25/g' -e ':a' -e 'N' -e '$!ba' -e 's/\n/%0A/g'
}

for log in "$@"; do
  name=$(basename "$log" .log)
  if [ ! -s "$log" ]; then
    printf '::error title=%s: no log captured,file=.github/workflows/ci.yml,line=1::nothing wrote %s, so the step died before running the command (shell incompatibility in this container, or the tool is not installed) — and every step below it in the job was skipped.\n' "$name" "$log"
    continue
  fi

  # Line numbers of the *distinct* error headers, in file order. mawk, not gawk (the runner image ships
  # mawk, which reads some gawk idioms as arithmetic and dies with exit 2 — a reporting step that fails
  # buries the report); `!s[m]++` is portable enough for both.
  markers=$(grep -nE '^error(\[[^]]*\])?:' "$log" 2>/dev/null |
    sed -e 's/^\([0-9]*\):.*/\1 &/' | awk '{m = $0; sub(/^[0-9]+ [0-9]+:/, "", m); if (!s[m]++) print $1}' |
    head -8 || true)
  [ -n "$markers" ] || markers=""
  errors=$(printf '%s\n' "$markers" | sed '/^$/d' | wc -l | tr -dc '0-9')
  [ -n "$errors" ] || errors=0

  for eno in $markers; do
    [ -n "$eno" ] || continue
    # the block is the error line through the first blank line below it (a diagnostic ends there), with a
    # byte cap so the whole annotation stays well under the message limit; `sed -n 'A,Bp'` because a range
    # that runs off the end of the file simply stops there, unlike `head -n +A | tail`.
    blk=$(sed -n "${eno},$((eno + 26))p" "$log" 2>/dev/null |
      sed -e '/^[[:space:]]*$/q' -e 's/^[[:space:]]*//' | cut -c1-140 | head -14 || true)
    [ -n "$blk" ] || blk=$(sed -n "${eno}p" "$log" 2>/dev/null || true)
    arrow=$(sed -n "$((eno + 1)),$((eno + 26))p" "$log" 2>/dev/null |
      grep -m1 -E '^[[:space:]]*--> [^ ]+:[0-9]+(:[0-9]+)?' || true)
    if [ -n "$arrow" ]; then
      pl=$(printf '%s' "$arrow" | sed -E 's/.*-->[[:space:]]*//' | cut -d' ' -f1)
      fpath=$(printf '%s' "$pl" | cut -d: -f1)
      fline=$(printf '%s' "$pl" | cut -d: -f2)
      printf '::error file=%s,line=%s,title=%s:%s::%s\n' "$fpath" "$fline" "$name" "$eno" "$(escnl "$blk")" || true
    else
      printf '::error file=.github/workflows/ci.yml,line=%s,title=%s:%s::%s\n' "$eno" "$name" "$eno" "$(escnl "$blk")" || true
    fi
  done

  # Positions for the *warning* diagnostics too, but only up to four slots and never at the expense of the
  # windows below: a warning is worth a pin on the file, not a page.
  grep -nE '^[[:space:]]*--> [^ ]+:[0-9]+:[0-9]+' "$log" 2>/dev/null | head -4 |
    sed -E 's/^([0-9]+):[[:space:]]*-->[[:space:]]*([^:]+):([0-9]+):([0-9]+).*$/\1 \2 \3/' |
    while read -r lineno path ln; do
      [ -n "$path" ] || continue
      msg=$(sed -n "$((lineno - 1))p" "$log" 2>/dev/null | sed 's/^[[:space:]]*//' | cut -c1-180 || true)
      # warning level, deliberately: run 5's check page showed four red "failure" annotations that were
      # `warning: unexpected cfg condition value` in a file that compiled fine, and a reader cannot tell
      # severity apart from noise.
      printf '::warning file=%s,line=%s,title=%s::%s\n' "$path" "$ln" "$name" "$(esc "$msg")" || true
    done

  # 8 diagnostics + 4 positions + the accounting line is 13, so the windows get what is left of ~50 — and
  # a floor, because two windows that vanish entirely is the failure mode this line exists to make visible.
  budget=$(( (44 - errors - 4) / 2 / nlogs ))
  [ "$budget" -gt 12 ] && budget=12
  [ "$budget" -lt 2 ] && budget=2
  per_side=$((budget * 2250))
  size=$(wc -c < "$log" 2>/dev/null | tr -dc '0-9')
  printf '::notice::surfacing %s: %s distinct error(s), %s chunks × %s bytes per side, log is %s bytes%s\n' \
    "$name" "$errors" "$budget" "$per_side" "${size:-?}" "$([ "${size:-0}" -gt "$per_side" ] && printf ' — truncated to the first and last %s' "$per_side")"

  for side in head tail; do
    b64=$($side -c "$per_side" "$log" 2>/dev/null | base64 -w0 2>/dev/null ||
      $side -c "$per_side" "$log" 2>/dev/null | base64 | tr -d '\n' || true)
    total=$(printf '%s' "$b64" | wc -c | tr -dc '0-9')
    [ -n "$total" ] || total=0
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

  # The summary is for a human on the job page, so it leads with the diagnostics rather than the tail — the
  # tail of a cargo log is usually `Compiling` lines of crates that succeeded.
  {
    printf '### %s — %s error block(s)\n\n' "$name" "$errors"
    for eno in $markers; do
      [ -n "$eno" ] || continue
      printf '```\n'
      sed -n "${eno},$((eno + 26))p" "$log" 2>/dev/null | sed -e '/^[[:space:]]*$/q' || true
      printf '```\n\n'
    done
    printf '### %s — last 4000 bytes\n\n```\n' "$name"
    tail -c 4000 "$log" 2>/dev/null || true
    printf '```\n\n'
  } >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
done
exit 0
