#!/bin/sh
# ci-surface-log.sh <log-path>… — turn a captured CI log into evidence you can read from the outside.
#
# Why this exists at all: the runner's log host is unreachable from a terminal (`gh api
# …/actions/jobs/<id>/logs` returns an empty reply — the blob host EOFs, and `curl` cannot reach it either),
# so the annotations GitHub publishes are the only thing that survives the trip, and by default they carry
# only "Process completed with exit code 101." That is not a diagnosis: the 101 turned out to be cargo's "no
# such command" for clippy, not 40 lints, and a later exit 2 was this file's own predecessor (a bashism in
# a dash container) rather than anything `anchor build` did.
#
# Shape, and the constraint behind each piece:
#   * one annotation per *distinct* diagnostic, carrying the whole block (message, `-->` position, the
#     `= note:`/`help:` lines) with newlines as %0A, which the API hands back decoded. A fixer needs
#     "expected …, found …" — that *is* a type error — and needs it for every occurrence: distinct means
#     "message and position", because `--all-targets` repeats an error once per target (those collapse)
#     while two real errors can share a message (run 6 had `lifetime may not live long enough` at
#     fusion.rs:129 *and* state.rs:123, and a message-only key published one of the two).
#   * `file=`/`line=` point at the `-->` path under the error when there is one, and at the *log line* when
#     there is not — cargo's own errors ("could not compile", "failed to parse manifest") have no source
#     position, and an annotation on nothing is worse than one that says which line to look near.
#   * two base64 windows after the diagnostics: `head` for toolchain identity (the first thing in every
#     captured log is which image and which cargo ran), `errs` for the region starting at the first error —
#     which is where a cargo failure actually lives, and the reason head+tail was the wrong pair: the tail of
#     a long log is `Compiling` lines of crates that succeeded.
#   * the payload is capped in BYTES, twice over: an annotation message is truncated at 3201 characters, so
#     a chunk is 3000 base64 chars (2250 raw bytes) and never 3200 — the first version asked for 3200, lost
#     six characters to that cap, and every window came back as "cannot be 1 more than a multiple of 4".
#     And a *check run* silently drops annotations past roughly 35-40 KB of total payload (run 6 shipped 5
#     of 12 head chunks and none of the tail; run 7 kept one tail chunk), so the whole report is built to
#     fit inside it rather than to be truncated by it: 8 diagnostics × 1.2 KB + 7 window chunks ≈ 22 KB.
#   * the accounting line is part of the report: it says how many errors were found, how many chunks ship,
#     and how big the log was, because a report that ships nothing has to distinguish "nothing to say" from
#     "cut off on the way out".
#   * a missing or empty log is itself an error annotation. Silence was ambiguous — "the command produced
#     nothing" vs "capture never ran" — and the second case is what hid two separate failures.
#   * the full error blocks and the last 6 KB go to $GITHUB_STEP_SUMMARY, where there is no 3201-char
#     budget. That is for the human on the job page; the annotations are for whoever has only the API.
#
# This step must never fail: it runs under `if: failure()`. Everything non-printing is `|| true` and the
# exit is unconditional.
set -u

# How many logs this step surfaced, read once up front: the arrow split below and `for log in "$@"` both
# rewrite the positional parameters, and a window count that depends on `$#` mid-run is how run 47's
# `cargo-lock` job ended up publishing zero windows — the arithmetic was "fine", the report was just empty.
nlogs=$#

# In a message only `%` needs escaping — unlike `key=value` properties, `::` is not a delimiter here, and
# escaping it would show the reader `%3A%3A`. Newlines become the %0A escape GitHub decodes back.
esc() { printf '%s' "$1" | tr -d '\r' | tr '\n' ' ' | sed 's/%/%25/g'; }
escnl() { printf '%s' "$1" | tr -d '\r' | sed -e 's/%/%25/g' -e ':a' -e 'N' -e '$!ba' -e 's/\n/%0A/g'; }

for log in "$@"; do
  name=$(basename "$log" .log)
  if [ ! -s "$log" ]; then
    printf '::error title=%s: no log captured,file=.github/workflows/ci.yml,line=1::nothing wrote %s, so the step died before running the command (shell incompatibility in this container, or the tool is not installed) — and every step below it in the job was skipped.\n' "$name" "$log"
    continue
  fi

  # Line numbers of the distinct error headers, in file order, max 8. Keyed on the header plus the first
  # line under it (the `-->` position) so per-target repeats collapse and genuinely separate errors do not.
  seen=""
  markers=""
  mi=0
  for eno in $(grep -nE '^error(\[[^]]*\])?:' "$log" 2>/dev/null | cut -d: -f1 || true); do
    [ "$mi" -lt 8 ] || break
    [ -n "$eno" ] || continue
    key=$(sed -n "${eno},$((eno + 8))p" "$log" 2>/dev/null |
      sed -e 's/^[[:space:]]*//' -e '/^[[:space:]]*$/d' | head -2 | tr '\n' '|')
    case " $seen " in *" $key "*) continue ;; esac
    seen="$seen $key"
    markers="$markers $eno"
    mi=$((mi + 1))
  done
  markers=$(printf '%s' "$markers" | sed 's/^ //')
  errors=$(printf '%s\n' "$markers" | tr ' ' '\n' | sed '/^$/d' | wc -l | tr -dc '0-9')
  [ -n "$errors" ] || errors=0
  first_err=$(printf '%s\n' "$markers" | tr ' ' '\n' | sed '/^$/d' | head -1)

  for eno in $markers; do
    [ -n "$eno" ] || continue
    # 10 lines × 140 columns: enough for the whole of a rustc diagnostic (message, span, the two `= note:`
    # lines, the `help:`), short enough that eight of them plus the windows stay inside the payload ceiling.
    blk=$(sed -n "${eno},$((eno + 26))p" "$log" 2>/dev/null |
      sed -e '/^[[:space:]]*$/q' -e 's/^[[:space:]]*//' | cut -c1-140 | head -10 || true)
    [ -n "$blk" ] || blk=$(sed -n "${eno}p" "$log" 2>/dev/null || true)
    arrow=$(sed -n "$((eno + 1)),$((eno + 26))p" "$log" 2>/dev/null |
      grep -m1 -E '^[[:space:]]*--> [^ ]+:[0-9]+(:[0-9]+)?' || true)
    if [ -n "$arrow" ]; then
      pl=$(printf '%s' "$arrow" | sed -E 's/.*-->[[:space:]]*//' | cut -d' ' -f1)
      printf '::error file=%s,line=%s,title=%s:%s::%s\n' \
        "$(printf '%s' "$pl" | cut -d: -f1)" "$(printf '%s' "$pl" | cut -d: -f2)" "$name" "$eno" "$(escnl "$blk")" || true
    else
      printf '::error file=.github/workflows/ci.yml,line=%s,title=%s:%s::%s\n' \
        "$eno" "$name" "$eno" "$(escnl "$blk")" || true
    fi
  done

  # Positions for the other diagnostics too (warnings are where the noise is), at warning level: run 5's
  # check page showed four red "failure" annotations for `unexpected cfg condition value` in a file that
  # compiled fine, and a reader cannot tell severity apart from noise.
  grep -nE '^[[:space:]]*--> [^ ]+:[0-9]+:[0-9]+' "$log" 2>/dev/null | head -4 |
    sed -E 's/^([0-9]+):[[:space:]]*-->[[:space:]]*([^:]+):([0-9]+):([0-9]+).*$/\1 \2 \3/' |
    while read -r lineno path ln; do
      [ -n "$path" ] || continue
      msg=$(sed -n "$((lineno - 1))p" "$log" 2>/dev/null | sed 's/^[[:space:]]*//' | cut -c1-160 || true)
      printf '::warning file=%s,line=%s,title=%s::%s\n' "$path" "$ln" "$name" "$(esc "$msg")" || true
    done

  size=$(wc -c < "$log" 2>/dev/null | tr -dc '0-9')
  [ -n "$size" ] || size=0
  # head: one chunk (2250 bytes) — the toolchain identity block is at the top of every captured log.
  # errs: six chunks (13 500 bytes) from the first error. Run 8 is the reason it is not three: `market (lib)
  # due to 11 previous errors`, of which the eight diagnostic slots and a 6750-byte window between them showed
  # two — an error list is only complete if the window can hold the crate's whole error region.
  printf '::notice::surfacing %s: %s distinct error(s), windows head×1 + errs×6 of 2250 bytes, log is %s bytes%s\n' \
    "$name" "$errors" "$size" "$([ "$size" -gt 9000 ] && printf ' (excerpted)')"

  for tag in head errs; do
    if [ "$tag" = head ]; then
      b64=$(head -c 2250 "$log" 2>/dev/null | base64 -w0 2>/dev/null ||
        head -c 2250 "$log" 2>/dev/null | base64 | tr -d '\n' || true)
      limit=1
    elif [ -n "$first_err" ]; then
      b64=$(sed -n "${first_err},\$p" "$log" 2>/dev/null | head -c 13500 | base64 -w0 2>/dev/null ||
        sed -n "${first_err},\$p" "$log" 2>/dev/null | head -c 13500 | base64 | tr -d '\n' || true)
      limit=6
    else
      b64=$(tail -c 13500 "$log" 2>/dev/null | base64 -w0 2>/dev/null ||
        tail -c 13500 "$log" 2>/dev/null | base64 | tr -d '\n' || true)
      limit=6
    fi
    total=$(printf '%s' "$b64" | wc -c | tr -dc '0-9')
    [ -n "$total" ] || total=0
    off=1
    i=0
    while [ -n "$b64" ] && [ "$off" -le "$total" ] && [ "$i" -lt "$limit" ]; do
      i=$((i + 1))
      # `cut -c A-B` is inclusive on both ends: the chunk is 3000 chars, not 3001, and the slack below the
      # API's 3201 is what keeps a changed prefix length from silently corrupting every window.
      chunk=$(printf '%s' "$b64" | cut -c"$off"-$((off + 2999)) || true)
      [ -n "$chunk" ] || break
      printf '::error title=%s-%s[%s],file=.github/workflows/ci.yml,line=1::log64:%s\n' "$name" "$tag" "$i" "$chunk"
      off=$((off + 3000))
    done
  done

  {
    printf '### %s — %s error block(s)\n\n' "$name" "$errors"
    for eno in $markers; do
      [ -n "$eno" ] || continue
      printf '```\n'
      sed -n "${eno},$((eno + 30))p" "$log" 2>/dev/null | sed -e '/^[[:space:]]*$/q' || true
      printf '```\n\n'
    done
    printf '### %s — around the first error\n\n```\n' "$name"
    if [ -n "$first_err" ]; then sed -n "${first_err},\$p" "$log" 2>/dev/null | head -c 6000; else tail -c 6000 "$log"; fi || true
    printf '\n```\n\n'
  } >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
done
exit 0
