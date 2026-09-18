#!/bin/sh
# ci-cargo-lock.sh — resolve, pin, and *prove* a Cargo.lock for the programs workspace. Called by
# .github/workflows/lockfile.yml, inside the same image the build gate uses.
#
# Why a workflow does this instead of a developer: a lockfile is the only place a version can be chosen for
# a *transitive* dependency, and here that choice is the difference between a red tree and a green one. The
# third-party crates that touch anchor-lang declare ranges our manifests cannot tighten (read from the
# registry index on 2026-09-18, not guessed):
#
#   switchboard-on-demand 0.13.0   anchor-lang >=0.31.0   (optional; the `anchor` feature turns it on)
#   pythnet-sdk 2.3.1              anchor-lang >=0.28.0   (optional; `solana-program` turns it on)
#   mpl-core 0.12.1                anchor-lang ^0.31.1 + kaigan/anchor → anchor-lang ^0.32.1
#
# A lower bound with no upper bound is satisfied by the newest major, so an unlocked resolve puts two or
# three copies of anchor-lang in the graph and every copy brings its own `borsh`. That is what
# `error[E0277]: the trait bound PriceFeedMessage: BorshSerialize is not satisfied`, with the note "there
# are multiple different versions of crate `borsh`", actually means: pyth's type derives the trait through
# one copy of anchor-lang while our `#[account]` bounds ask for another. The program source is not wrong;
# the graph is. So the pin below is not a taste for an old version — it is "the copy Anchor.toml's CLI
# matches", which is the only one whose derives our bounds can see.
#
# The script refuses to hand over an unverified lock: `cargo check --workspace --all-targets` has to pass,
# because a lockfile committed by a bot that cannot compile is how a build gate becomes a rumour.
set -u

# Progress bars are control characters; a redirected log full of them is not evidence (the first version of
# this file's output ended in 800 bytes of what looked like corrupted CP437 and no error line at all).
CARGO_TERM_COLOR=never
CARGO_TERM_PROGRESS_WHEN=never
export CARGO_TERM_COLOR CARGO_TERM_PROGRESS_WHEN

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cd "$root" || exit 1

want=$(sed -n 's/^anchor_version *= *"\([^"]*\)".*/\1/p' Anchor.toml | head -1)
if [ -z "$want" ]; then
  echo "::error::Anchor.toml has no [toolchain] anchor_version — the pin has nothing to pin to"
  exit 1
fi
echo "pin: anchor-lang $want (read from Anchor.toml [toolchain], not hardcoded here)"

if ! cargo generate-lockfile; then
  echo "::error::cargo generate-lockfile failed — nothing to pin, nothing to commit"
  exit 1
fi

copies_of() { cargo tree -e normal,build --prefix none 2>/dev/null | grep -oE "^$1 v[0-9][^ ]*" | sed 's/^[^ ]* v//' | sort -u; }

# `cargo update -p anchor-lang --precise …` is not one command here, it is a *set*: once the graph holds
# several copies of a crate the bare name is ambiguous, and cargo says so ("multiple `anchor-lang` packages
# … re-run with one of: anchor-lang@0.31.2, anchor-lang@0.32.2, …"). So each copy is addressed by version
# and offered the wanted one; cargo moves it only if the dependent's requirement can accept it. That
# distinction is the finding: `>=0.31.0` and `>=0.28.0` accept $want, kaigan's hard `^0.32.1` does not, and
# no manifest edit on our side changes that.
#
# Repeated to a fixpoint (max 3), because the two crates are coupled: anchor-spl 0.31.2 requires
# `anchor-lang ^0.31.2`, so pass 1 cannot move anchor-lang to 0.31.1 — it has to move anchor-spl first.
# One pass leaves the graph half-pinned, which is exactly what run 2 did: "ok: anchor-spl 0.31.2 -> 0.31.1"
# beside a refused anchor-lang, and a lock that nobody can read as "the pinned toolchain".
refused=""
pass=1
while [ "$pass" -le 3 ]; do
  changed=0
  for c in anchor-lang anchor-spl; do
    for v in $(copies_of "$c"); do
      [ "$v" = "$want" ] && continue
      if cargo update -p "$c@$v" --precise "$want" >/dev/null 2>&1; then
        echo "pass $pass: $c $v -> $want"
        changed=1
        # a copy refused on pass 1 that moves on pass 2 is not "kept by its dependents" — leaving it in the
        # list would describe a pin that worked as one that did not
        refused=$(printf '%s' "$refused" | sed "s| $c@$v ||g")
      else
        case "$refused" in *" $c@$v "*) : ;; *) refused="$refused $c@$v " ;; esac
      fi
    done
  done

  # The second, sharper move: which copy a *specific dependent* resolved to. Unifying by version is
  # impossible here — chip_core needs ^0.31.1, kaigan (mpl-core's anchor feature) needs ^0.32.1, so two
  # copies exist by construction and stay. What decides whether the tree compiles is which of them
  # pythnet-sdk and switchboard-on-demand sit on: their ranges are unbounded (`>=0.28.0`, `>=0.31.0`), so
  # cargo happily answers them with 0.32, and then `PriceUpdateV2`'s borsh derive is the 1.x one while
  # `#[account]` asks for the 0.10 one — E0277 with "multiple different versions of crate borsh". A lockfile
  # can express the assignment that no manifest on our side can: the `-p <dependent>/<dep>` spec edits one
  # dependent's edge and leaves the other copy for kaigan. Both spellings are tried because the accepted
  # spec grammar has moved across cargo versions and this runs on the image's 1.79.
  for off in pythnet-sdk switchboard-on-demand; do
    offv=$(cargo tree -e normal,build -p "$off" 2>/dev/null | head -1 | grep -oE 'v[0-9][^ ]*' | cut -c2- || true)
    for v in $(copies_of anchor-lang); do
      [ "$v" = "$want" ] && continue
      # Is $off actually resolving to $v? Its own subtree is the only honest answer: `cargo tree -p` prints
      # the dependencies of that one package, so a hit means "this dependent chose this copy". A package
      # that is not in the graph at all (switchboard's `anchor` feature off, say) prints nothing and is
      # skipped — the absence of a match is not a failure to pin.
      cargo tree -e normal,build -p "$off" --prefix none 2>/dev/null |
        grep -qE "^[[:space:]]*anchor-lang v$v( |$)" || continue
      moved=""
      for spec in "$off/anchor-lang" "$off@$offv/anchor-lang"; do
        case "$spec" in *"@/"*) continue ;; esac
        if cargo update -p "$spec" --precise "$want" >/dev/null 2>&1; then
          moved="$spec"
          break
        fi
      done
      if [ -n "$moved" ]; then
        echo "pass $pass: edge $moved -> anchor-lang $want (was $v)"
        changed=1
      else
        echo "pass $pass: $off stays on anchor-lang $v — no edge spec cargo accepted; the check below decides"
      fi
    done
  done

  [ "$changed" = 0 ] && break
  pass=$((pass + 1))
done
if [ -n "$refused" ]; then
  # Named, and not fatal: these are the copies the graph is allowed to keep, and the compile below decides
  # whether keeping them is survivable. Silently leaving them out is how a pin looks like it worked.
  printf '::notice::kept by their dependents (structural, not a failure):%s\n' "$refused"
fi

# --- the other half of a usable lock: cargo has to be able to *read* it ---------------------------------
# The pin above answers "which copy of anchor-lang"; this answers "can the toolchain that builds the .so
# parse these manifests at all". `anchor build` runs `cargo build-sbf`, which puts the cargo bundled in the
# Agave release (2.1.0 -> cargo 1.79.0) before the image's own, and a manifest declaring `edition = "2024"`
# is then fatal four minutes into a build, with a message that names a crate and not a fix.
#
# getrandom 0.4 is reachable here only through dev-dependencies (proptest -> rusty-fork -> tempfile 3.27,
# whose own range is `>=0.3.0, <0.5`), so the graph can drop the entire 0.4 line with a version choice and
# nothing in our manifests changes. Entries: <crate> <forbidden line> <pin to>. If cargo refuses (a
# dependent with a narrower bound), the error names the crate — the answer is a second entry for *that*
# dependent, never a wider `Cargo.lock` hand-edit, which the next resolve would undo silently.
# Two primitives the SBF-readability pass below needs. Both are here rather than inline because the pass is
# a loop over *whatever* cargo 1.79 chokes on, and that list is not knowable in advance (getrandom in the
# first week, zeroize in the second: both were reached through ordinary `1.x` bumps, neither through a
# manifest we control).
#
# The index is queried over the network rather than from `$CARGO_HOME/registry/index/*/.cache`, which is
# cargo's own blake3-hashed binary format — unreadable without reimplementing half of cargo, and the whole
# point of this pass is that it must keep working when nobody has time to read cargo.
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -sSfL --max-time 90 "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O - "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request; sys.stdout.write(urllib.request.urlopen(sys.argv[1], timeout=90).read().decode())' "$1"
  else
    return 127
  fi
}

# crates.io's index path rule, spelled out because the 1/2/3-char cases are the ones that silently 404.
idx_path() {
  n=$1
  case ${#n} in
    1) printf '1/%s' "$n" ;;
    2) printf '2/%s' "$n" ;;
    3) printf '3/%s/%s' "$(printf '%s' "$n" | cut -c1)" "$n" ;;
    *) printf '%s/%s/%s' "$(printf '%s' "$n" | cut -c1-2)" "$(printf '%s' "$n" | cut -c3-4)" "$n" ;;
  esac
}

# The newest version of $1 that (a) is in the same major, (b) sorts strictly below $3, (c) is not yanked,
# not a prerelease, and (d) declares a `rust_version` at or below $2 — the SBF cargo's own version. A record
# without `rust_version` is kept: those are old crates, and `sort -V` puts them where they belong. If a
# pre-2024 crate ever omits the field, the loop just runs once more against the next offender.
# Exit tells the caller *why* it got nothing: 1 = the index answered and there is genuinely no candidate (so a
# human has to choose a version outside the same-major rule), 2 = the index could not be read at all (so the
# right advice is to re-run or pin by hand, not "the registry has nothing"). Collapsing the two would print
# "no such version exists" on a network timeout, which is how a tool earns a reader who no longer believes it.
newest_readable() { # <crate> <cargo "1.79"> <offender "1.9.0">  -> 0 pick | 1 no candidate | 2 index unreadable
  cr=$1; bound=$2; below=$3
  body=$(http_get "https://index.crates.io/$(idx_path "$cr")") || return 2
  [ -n "$body" ] || return 2
  # The line `cargo update --precise` may move inside without asking anyone. For a 0.x crate that line is
  # major.minor, not major: semver treats 0.2 and 0.3 as different crates, so a "same-major" rule offered
  # cpufeatures 0.2.17 as a downgrade of 0.3.1, and cargo refused it — correctly, since the dependents holding
  # `^0.3` cannot accept 0.2.x (run 22's log is that refusal, printed as if the pin were at fault).
  # The line `cargo update --precise` may move inside without asking anyone: for a 0.x crate it is
  # major.minor, for everything else it is the major. Both halves matter. Getting the first wrong offered
  # cpufeatures 0.2.17 as a "downgrade" of 0.3.1, which cargo refused because the dependents hold `^0.3`
  # (run 22's log printed that refusal as if the pin were at fault). Getting the second wrong would bury
  # zeroize: 1.8.2 and 1.9.0 share the *major*, and the first version of this rule compared `1.9` to `1.8`
  # and answered "nothing exists" about a pin that had just worked in CI.
  bmaj=$(printf '%s' "$below" | cut -d. -f1)
  if [ "$bmaj" = "0" ]; then
    bline=$(printf '%s' "$below" | cut -d. -f1,2)
    if [ "$bline" = "0.0" ]; then bmajor="0"; bf=1; else bmajor=$bline; bf=2; fi
  else
    bmajor=$bmaj; bf=1
  fi
  bm1=$(printf '%s' "$bound" | cut -d. -f1)
  bm2=$(printf '%s' "$bound" | sed 's/^[0-9]*\.//' | cut -d. -f1)
  cf=$(mktemp); af=$(mktemp); wf=$(mktemp)
  # Fresh temp files per call, not fixed names: this function runs once per round of the pass below, and a
  # `/tmp/sbf-cands` left by an earlier round would be concatenated with this round's list — which reads as
  # "the pin found a candidate" when what it found was its own stale output.
  printf '%s\n' "$body" | while IFS= read -r line; do
    case "$line" in *'"yanked":true'*) continue ;; esac
    v=$(printf '%s' "$line" | sed -n 's/.*"vers":"\([^"]*\)".*/\1/p')
    [ -n "$v" ] || continue
    case "$v" in *-*) continue ;; esac
    [ "$(printf '%s' "$v" | cut -d. -f1,"$bf")" = "$bmajor" ] || continue
    rv=$(printf '%s' "$line" | sed -n 's/.*"rust_version":"\([^"]*\)".*/\1/p')
    if [ -n "$rv" ]; then
      r1=$(printf '%s' "$rv" | cut -d. -f1); r2=$(printf '%s' "$rv" | sed 's/^[0-9]*\.//' | cut -d. -f1)
      if [ "$r1" -gt "$bm1" ] 2>/dev/null || { [ "$r1" = "$bm1" ] && [ "$r2" -gt "$bm2" ] 2>/dev/null; }; then
        continue
      fi
    fi
    printf '%s c\n' "$v"
  done > "$cf"
  # A second tier, deliberately: the same-line rule is what cargo would call "semver compatible without
  # asking", but the line is *narrower* than the graph's real freedom — tempfile asks for
  # `getrandom >=0.3.0, <0.5`, so 0.4.3 -> 0.3.4 is a legal move across lines, and it is exactly the pin that
  # removed E0277 from this repo. So: prefer same-line, and fall back to the newest readable version in the
  # same major, marked `w`. cargo is the arbiter either way (it refuses what a dependent's requirement
  # excludes), so the fallback cannot silently widen anything — it can only be refused, and a refusal hands
  # the decision to the dependent walk below.
  printf '%s\n' "$body" | while IFS= read -r line; do
    case "$line" in *'"yanked":true'*) continue ;; esac
    v=$(printf '%s' "$line" | sed -n 's/.*"vers":"\([^"]*\)".*/\1/p')
    [ -n "$v" ] || continue
    case "$v" in *-*) continue ;; esac
    [ "$(printf '%s' "$v" | cut -d. -f1)" = "$bmaj" ] || continue
    rv=$(printf '%s' "$line" | sed -n 's/.*"rust_version":"\([^"]*\)".*/\1/p')
    if [ -n "$rv" ]; then
      r1=$(printf '%s' "$rv" | cut -d. -f1); r2=$(printf '%s' "$rv" | sed 's/^[0-9]*\.//' | cut -d. -f1)
      if [ "$r1" -gt "$bm1" ] 2>/dev/null || { [ "$r1" = "$bm1" ] && [ "$r2" -gt "$bm2" ]; } 2>/dev/null; then
        continue
      fi
    fi
    printf '%s w\n' "$v"
  done > "$wf"
  printf '%s\n' "$body" | while IFS= read -r line; do
    v=$(printf '%s' "$line" | sed -n 's/.*"vers":"\([^"]*\)".*/\1/p')
    [ -n "$v" ] || continue
    case "$v" in *-*) continue ;; esac
    [ "$(printf '%s' "$v" | cut -d. -f1,"$bf")" = "$bmajor" ] || continue
    printf '%s a\n' "$v"
  done > "$af"
  # The offender is injected into its own sort stream, so "strictly below" is decided by order rather than by a
  # semver comparison: if the index no longer lists the offending version (yanked and pruned, or a renumber),
  # the alternative — never seeing `$1 == below` — would let every candidate through and return one *above*
  # what we are trying to escape. `&& $1 != below` closes the mirror case where a candidate ties the offender.
  { cat "$af"; printf '%s b\n' "$below"; cat "$cf"; } | sort -V -k1,1 | awk -v below="$below" '
    { if ($1 == below) stop = 1; if (!stop && $2 == "c" && $1 != below) best = $1 }
    END { if (best == "") exit 1; print best }' || {
    { cat "$af"; printf '%s b\n' "$below"; cat "$wf"; } | sort -V -k1,1 | awk -v below="$below" '
      { if ($1 == below) stop = 1; if (!stop && $2 == "w" && $1 != below) best = $1 }
      END { if (best == "") exit 1; print best " wide" }'
    rc=$?
    rm -f "$cf" "$af" "$wf"
    return $rc
  }
  rc=$?
  rm -f "$cf" "$af" "$wf"
  return $rc
}

# The capture is taken before the loop, not after: the loop has to know whether a forbidden line is present at
# all, and `versions()` below re-uses the same string. With `set -u` on, reading an unset `$tree` is an exit
# rather than an empty string, and the first draft of this block had the assignment after the loop — which is
# a pin that quietly never ran, the one failure mode a pin script is not allowed to have.
tree=$(cargo tree -e normal,build --prefix none 2>/dev/null || true)
sbf_refused=""
while read -r s_c s_line s_pin; do
  [ -n "$s_c" ] || continue
  found=$(printf '%s\n' "$tree" | grep -oE "^$s_c v$s_line\\.[0-9][^ ]*" | sed 's/^[^ ]* v//' | head -1)
  [ -n "$found" ] || continue
  if cargo update -p "$s_c@$found" --precise "$s_pin" >/tmp/sbf-pin-$s_c.log 2>&1; then
    echo "sbf-readability: $s_c $found -> $s_pin (so the SBF cargo 1.79 can read every manifest in the lock)"
    tree=$(cargo tree -e normal,build --prefix none 2>/dev/null || true)
  else
    sbf_refused="$sbf_refused $s_c@$found"
    printf '::error::sbf-readability: cargo refused to move %s@%s to %s — the dependent that holds it needs a narrower bound, so add that dependent to the list above (log: %s)\n' "$s_c" "$found" "$s_pin" "$(grep -m1 -E '^(error|warning)' /tmp/sbf-pin-$s_c.log | cut -c1-160 || true)"
  fi
done <<'SBFPINS'
getrandom 0.4 0.3.4
zeroize 1.9 1.8.2
SBFPINS
if [ -n "$sbf_refused" ]; then
  echo "::error::the SBF-readable pin could not be applied for:$sbf_refused — refusing to commit a lock that anchor build cannot read"
  exit 1
fi

versions() { printf '%s\n' "$tree" | grep -oE "^$1 v[0-9][^ ]*" | sort -u; }
# lines, not words: each version is one `<crate> v<x.y.z>` pair, and `wc -w` on it said "2" for a single
# copy — a count that gates a commit has to count copies, not tokens.
count() { versions "$1" | sed '/^$/d' | wc -l | tr -d ' '; }
echo "== copies in the resolved graph"
for c in anchor-lang anchor-spl borsh solana-program; do
  printf '   %-16s %s version(s): %s\n' "$c" "$(count "$c")" "$(versions "$c" | tr '\n' ' ')"
done

# The invariant decidable from the version list: no anchor-lang outside the pinned line and kaigan's 0.32.
# "Exactly one copy" is not achievable here (mpl-core reaches kaigan, kaigan hard-requires ^0.32.1), and
# asserting the impossible turns a passing build into a red gate — the failure mode this file exists to
# avoid, which is how run 2 came to refuse a lock that was in fact fine.
line=$(printf '%s' "$want" | cut -d. -f1-2)   # "0.31"
copies=$(count anchor-lang)
stray=$(versions anchor-lang | sed '/^$/d' | grep -cEv "^anchor-lang v($line|0\\.32)\\." || true)
printf 'anchor-lang: %s copy/copies; %s outside the allowed lines (%s and 0.32)\n' "$copies" "${stray:-0}" "$line"
if [ "${stray:-1}" != "0" ]; then
  printf '::error::anchor-lang still resolves to a copy outside %s/0.32 — an unbounded `>=` found another major, which is the E0277 returning, so this lock is not worth committing\n' "$line"
  exit 1
fi
# Which copy the two crates that broke sit on — reported, not enforced. pythnet-sdk's `>=0.28.0` is
# legitimately satisfied by kaigan's 0.32 copy, and 0.32's borsh wiring is the same 0.10 release, so such a
# graph compiles even though a stricter assertion than the compiler's own would reject it. `cargo tree -i`
# draws a tree, so the box-drawing characters become newlines before matching: an anchored grep over that
# output finds nothing, and "nothing" here would have to be read as "the pin failed".
for c in pythnet-sdk switchboard-on-demand; do
  on=$(cargo tree -e normal,build -i "anchor-lang@$want" 2>/dev/null | tr -c 'a-zA-Z0-9 ._-' '\n' | grep -oE "$c v[0-9][^ ]*" | head -1 || true)
  printf '   %s: %s\n' "$c" "${on:-not under anchor-lang@$want (another copy satisfies its range — the check below decides)}"
done

echo "== proof: cargo check --workspace --all-targets"
# ── 3.5 The graph must be readable by the cargo that builds the .so ────────────────────
#
# Why this lives here and not only in the `programs` job: an unpinned edition-2024 dependency is a defect in
# the committed lockfile, and a green lock job next to a red `programs` leaves main carrying a lock that
# cannot build. `programs` cannot repair it — it does not write the lock — so the writer repairs it and the
# job keeps checking it (the same script, run again, is what goes red there when this pass could not).
#
# Why a pass rather than only the curated list above: `getrandom 0.3.4` was found by hand at 20:46 and
# `zeroize 1.9.0` sat in the same lockfile at the same moment — two members of one class, discovered one CI
# round apart. A list costs a round per member; the walk costs one run for the class. It also pins *up*
# instead of down: working from memory I wrote `zeroize 1.8.1`, while the registry's own `rust_version` field
# says 1.8.2 is the newest 1.8.x an SBF cargo 1.79 can read.
#
# Deliberately narrow: only a manifest this cargo cannot *parse* triggers a downgrade. A refusal to agree with
# `--locked` is not evidence about the on-chain build, and treating it as such would have this job edit the
# graph to satisfy a version check that does not decide the build (run 60 proved 1.79 refuses a 1.89-written
# lock for reasons that have nothing to do with the .so).
#
# Bounded at eight rounds: `cargo update --precise` can pull in a newer transitive child that is itself
# edition 2024, and an unbounded repair loop is how a CI job becomes a generator. Each round prints one
# `sbf-autopin:` line — that is the audit trail, and the summary line counts the steps.
sbf_cargo=""; sbf_ver=""
if [ -f scripts/ci-sbf-toolchain-check.sh ]; then
  probe=$(sh scripts/ci-sbf-toolchain-check.sh --probe "$root" 2>/dev/null | grep '^sbf-')
  sbf_cargo=$(printf '%s\n' "$probe" | sed -n 's/^sbf-cargo //p')
  sbf_ver=$(printf '%s\n' "$probe" | sed -n 's/^sbf-cargo-version //p')
fi
autopin_steps=0
if [ ! -f Cargo.lock ]; then
  echo "sbf-autopin: Cargo.lock ещё нет — спрашиваем после Materialize"
elif [ -z "$sbf_cargo" ] || [ -z "$sbf_ver" ]; then
  echo "sbf-autopin: SBF-cargo не найден — вопрос о читаемости манифестов здесь не задаётся"
else
  bound=${sbf_ver%.*}   # cargo 1.79.0 -> крайний rust_version, который он ещё читает: 1.79
  retries=3             # сколько раз за прогон разрешено трогать держателей рёбер, а не сам offender
  echo "== SBF-readable-manifest pass (cargo $sbf_ver, крайний rust_version $bound)"
  round=1
  while [ "$round" -le 8 ]; do
    # Both streams into a file: cargo reports on stderr, but a capture that drops stdout (`$(cmd 2>&1
    # >/dev/null)`, the shape this line had) means a tool that ever prints its error on stdout is read as
    # "refused for an unknown reason" — and this loop's whole decision hangs on that text.
    err=$(mktemp)
    "$sbf_cargo" metadata --format-version 1 >"$err" 2>&1; rc=$?
    if [ $rc -eq 0 ]; then
      rm -f "$err"
      if [ "$autopin_steps" -gt 0 ]; then
        echo "sbf-autopin: граф читается SBF-тулчейном после $autopin_steps шаг(ов) вниз"
      else
        echo "sbf-autopin: граф уже читается SBF-тулчейном — не трогаем"
      fi
      break
    fi
    # Cargo names the offending manifest as .../registry/src/<hash>/<crate>-<version>/Cargo.toml — its own
    # wording is the anchor, because "we could not read it" without the name is not a thing a log can act on.
    bad=$(sed -n 's|.*/\([A-Za-z0-9._-]*\)-\([0-9][0-9a-zA-Z.+-]*\)/Cargo.toml.*|\1 \2|p' "$err" | head -1)
    if [ -z "$bad" ]; then
      echo "sbf-autopin: cargo $sbf_ver отказал, но не на разборе манифеста — ничего не пиним; начало отказа:"
      # $err is a *file*, and the first draft quoted "$err" itself, so the log printed the temp filename where
      # cargo's message belonged — a two-line note that tells the reader nothing and costs a round to notice.
      # Prefer cargo's own error lines; fall back to the head of the output when even those are absent.
      grep -E 'error|Caused by' "$err" | head -4 | sed 's/^/  /'
      grep -qE 'error|Caused by' "$err" || head -4 "$err" | sed 's/^/  /'
      rm -f "$err"
      break
    fi
    set -- $bad
    name=$1; over=$2
    # SBFPINS lines are `<crate> <version-line> <pin>` — the *line*, e.g. `zeroize 1.9 1.8.2`, matched as
    # `^$crate v$line\.[0-9]`. Quoting the offender's full version back into that advice would produce
    # `zeroize 1.9.0 1.8.2`, a line the list's own grep cannot see: the instruction would read as followed
    # and do nothing.
    line=$(printf '%s' "$over" | cut -d. -f1,2)
    [ "$(printf '%s' "$over" | cut -d. -f1)" = "0" ] || line=$(printf '%s' "$over" | cut -d. -f1)
    moved=""; holders=""
    pick=$(newest_readable "$name" "$bound" "$over"); prc=$?
    tier=strict; case "$pick" in *\ wide) pick=${pick% wide}; tier=wide ;; esac
    if [ "$prc" -eq 2 ]; then
      # The distinction the whole block is built on: an unreadable index is not evidence about the crate.
      rm -f "$err" "$upd"
      echo "::error title=sbf-autopin::индекс crates.io не прочитан для $name (сеть/404) — шаг не может выбрать версию, и это не значит, что её нет. Если $over реально нужна в графе, зафиксируйте строкой \"$name $line <подходящая>\" в SBFPINS; иначе — перезапустите lockfile.yml"
      break
    fi
    # The repo's cargo, never the SBF one, does the writing — for both tiers of the move. Asking a cargo that
    # cannot read part of this graph to re-resolve it produces a refusal meaning "I could not read the answer",
    # indistinguishable from "the graph forbids it", and every branch below keys on that difference. The SBF
    # cargo's role is one-directional: it is the oracle that says whether the result is readable, nothing more.
    # (The lockfile's format is not a concern: main already carried a `version = 4` lock written by 1.89, and
    # run 61 shows the image's 1.79 getting past it to the manifests — the only thing it has to do.)
    upd=$(mktemp)
    if [ -n "$pick" ]; then
      echo "sbf-autopin: $name $over -> $pick (rust_version <= $bound, строка $line, ярус $tier)"
      if cargo update -p "$name@$over" --precise "$pick" >"$upd" 2>&1; then
        moved=yes
      else
        # cargo's own first error line, quoted: "the requirement is narrower than the version we offered" and
        # "the package does not exist" read identically after the fact, and only one of them is a hint to go
        # looking at the dependents.
        echo "sbf-autopin:   отказ: $(grep -m1 -E '^(error|warning)' "$upd" | cut -c1-220 || true)"
      fi
    fi
    # Nothing readable exists in the offender's own line, or the move was refused: some dependent is holding
    # the requirement. Ask the repo's cargo who pulls this crate in (it can read every manifest here, which is
    # the point of asking it instead of the SBF one) and try moving each holder down its own line. This is the
    # trick that fixed the anchor-lang graph — `cargo update -p pythnet-sdk/anchor-lang --precise`, an edge
    # rather than a crate. The loop's own re-check is the judge: if the move does not remove the offender, the
    # next round says so and the next holder gets its turn; every attempt is a strict downgrade, so progress
    # is monotone and `retries` is a belt, not a brake.
    if [ -z "$moved" ] && [ "$retries" -gt 0 ]; then
      echo "sbf-autopin: у $name $over не чинится изнутри строки — спрашиваю, кто держит это ребро"
      # --depth 1: the crates that *directly* require the offender. Without it the inverted tree also lists
      # every ancestor — and "fix the edge by downgrading anchor-lang" is not a fix, it is undoing the
      # toolchain pin a few lines above, which the anchor-lang check would then have to catch after the fact.
      holders=$(cargo tree -i "$name@$over" --depth 1 -e normal,build --prefix none 2>/dev/null | grep -oE '^[a-z0-9._-]+ v[0-9][^ ]*' | awk '!s[$0]++' | head -6)
      # Printed, not implied: "no holder found" and "four holders, none movable" look identical in the log
      # otherwise, and they are different work. It also lets the escalation quote the same list it used.
      echo "sbf-autopin: держатели ребра: [$(printf '%s' "$holders" | tr '\n' ' ')]"
      # Split on lines, not words: each holder is `<crate> v<version>`, and the default IFS made the loop see
      # four items — "blake3", "v1.8.7", "anchor-lang", "v0.31.1" — so every holder looked up an empty version,
      # found no candidate, and the pass reported "holders exist, nothing worked" while never trying one.
      # A `printf | while read` pipe would fix the splitting and lose the flags (`moved`, `retries` are set in
      # a subshell there), which is worse: the loop would move the graph and the round would still call it a
      # failure. Hence saving and restoring IFS around a plain for.
      oldIFS=$IFS
      IFS='
'
      for h in $holders; do
        IFS=$oldIFS
        hn=$(printf '%s' "$h" | cut -d' ' -f1); hv=$(printf '%s' "$h" | sed 's/^[^ ]* v//')
        # `cargo tree -i` lists the queried package itself among its own dependents, and trying it again is a
        # second refusal of the exact command that just failed — loud, wasteful, and it reads like a bug.
        [ "$hn" = "$name" ] && continue
        # Belt for the belt: these two are pinned to Anchor.toml's anchor_version by the pass above, so a
        # holder pass that could move them would trade an unreadable manifest for a toolchain mismatch.
        case "$hn" in anchor-lang|anchor-spl) continue ;; esac
        IFS='
'
        hpick=$(newest_readable "$hn" "$bound" "$hv"); hrc=$?
        hpick=${hpick% wide}
        if [ -z "$hpick" ]; then
          # Skip quietly only when the index answered "nothing below this version". A skipped registry lookup
          # is a different fact, and the difference is the reader's next step.
          [ "$hrc" = 2 ] && echo "sbf-autopin:     пропуск: индекс $hn не прочитан"
          continue
        fi
        echo "sbf-autopin:   пробую держателя: $hn $hv -> $hpick"
        if cargo update -p "$hn@$hv" --precise "$hpick" >"$upd" 2>&1; then
          retries=$((retries-1)); moved=yes
          echo "sbf-autopin: $hn понижен до $hpick — перепроверяю граф"
          break
        fi
        # Без этой строки отказ держателя не отличается от «держателя нет»: в прогоне 23 лог говорил
        # «понижение держателей не помогло», и по нему нельзя было понять, что попытки вообще были.
        echo "sbf-autopin:     отказ: $(grep -m1 -E '^(error|warning)' "$upd" | cut -c1-220 || true)"
      done
      IFS=$oldIFS
    fi
    if [ -z "$moved" ]; then
      rm -f "$err"
      # Два разных «не вышло», и они ведут к разной работе. Прогон 23 сказал «ни одна версия не читаема» там,
      # где читаемая версия была (indexmap 2.13.1 и ниже — rust_version 1.82) и отказал сам cargo: сообщение
      # было не просто неточным, оно отправляло человека искать несуществующую версию вместо того, чтобы
      # смотреть на диапазоны потребителей.
      if [ -z "$pick" ]; then
        echo "::error title=sbf-autopin::cargo $sbf_ver (SBF-тулчейн образа) не читает манифест $name $over, и в реестре нет ни одной версии строки $line ниже $over с rust_version <= $bound — значит понижать надо не $name, а того, кто требует $over (держатели: $(printf '%s' "$holders" | cut -d' ' -f1 | tr '\n' ' ')); зафиксируйте их понижение строкой \"<crate> <строка> <пин>\" в SBFPINS"
      else
        echo "::error title=sbf-autopin::читаемая версия $name существует ($pick, rust_version <= $bound), но cargo отказалась принять её и для $name@$over, и для держателей ($(printf '%s' "$holders" | cut -d' ' -f1 | tr '\n' ' ')) — блокируют их диапазоны в манифестах; либо понижайте держателя через SBFPINS строкой \"<держатель> <строка> <пин>\" так, чтобы его требование допускало $pick, либо поднимайте SBF-cargo (Anchor.toml: solana_version)"
      fi
      break
    fi
    rm -f "$upd"
    rm -f "$err"
    autopin_steps=$((autopin_steps+1))
    round=$((round+1))
  done
  if [ "$round" -gt 8 ]; then
    echo "::error title=sbf-autopin::восемь шагов вниз не сделали граф читаемым для cargo $sbf_ver — см. строки sbf-autopin выше и список SBFPINS"
  fi
fi

if ! cargo check --workspace --all-targets; then
  echo "::error::the pinned graph does not compile — refusing to commit this Cargo.lock. The log says which crate; if it is the pyth/mpl borsh bound again, the fix is a version choice in this script or in programs/*/Cargo.toml, not an annotation in the programs."
  exit 1
fi

# Then the gate `programs` runs, on the graph this pass just produced (its own `--locked` reading, so a stale
# lock cannot be committed). A green `cargo check` above is cargo 1.89's opinion; the opinion that has to live
# with this lockfile is the SBF toolchain's, so both are required before the commit.
if [ -f scripts/ci-sbf-toolchain-check.sh ]; then
  sbf_out=$(sh scripts/ci-sbf-toolchain-check.sh "$root" 2>&1); sbf_rc=$?
  printf '%s\n' "$sbf_out"
  case "$sbf_rc" in
    0) ;;
    # Not being able to ask is not the same as being told no: a workstation run has no solana on PATH, and
    # that must not read as a broken graph. `programs` asks the same question in the image that builds.
    2) echo "::warning::the SBF cargo is not in this environment, so the lock is committed unproven against it" ;;
    *) echo "::error::refusing to commit a Cargo.lock the SBF cargo cannot read — SBFPINS and the pass above are where that is fixed"
       exit 1 ;;
  esac
fi

if ! grep -q '^name = "anchor-lang"' Cargo.lock; then
  echo "::error::no Cargo.lock with an anchor-lang entry — generate-lockfile wrote something unexpected"
  exit 1
fi

bytes=$(wc -c < Cargo.lock | tr -d ' ')
packages=$(grep -c '^name = ' Cargo.lock | tr -d ' ')
echo "ready: Cargo.lock ($bytes bytes, $packages packages, anchor-lang $want)"
# The workflow step emits the outputs from its own lines; this file is how it learns what was decided, and
# the fallback in the step is what makes "the script died before writing it" a different answer from
# "the script decided there is nothing to say".
summary="anchor-lang $want, $packages packages, $bytes bytes"
[ "$autopin_steps" -eq 0 ] || summary="$summary, sbf-autopin $autopin_steps"
printf '%s\n' "$summary" > "${LOCK_SUMMARY:-/tmp/cargo-lock.summary}"
