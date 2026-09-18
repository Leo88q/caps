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
  [ "$changed" = 0 ] && break
  pass=$((pass + 1))
done
if [ -n "$refused" ]; then
  # Named, and not fatal: these are the copies the graph is allowed to keep, and the compile below decides
  # whether keeping them is survivable. Silently leaving them out is how a pin looks like it worked.
  printf '::notice::kept by their dependents (structural, not a failure):%s\n' "$refused"
fi

tree=$(cargo tree -e normal,build --prefix none 2>/dev/null || true)
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
if ! cargo check --workspace --all-targets; then
  echo "::error::the pinned graph does not compile — refusing to commit this Cargo.lock. The log says which crate; if it is the pyth/mpl borsh bound again, the fix is a version choice in this script or in programs/*/Cargo.toml, not an annotation in the programs."
  exit 1
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
printf '%s\n' "anchor-lang $want, $packages packages, $bytes bytes" > "${LOCK_SUMMARY:-/tmp/cargo-lock.summary}"
