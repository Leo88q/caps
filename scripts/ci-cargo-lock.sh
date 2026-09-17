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
# `error[E0277]: the trait bound PriceFeedMessage: BorshSerialize is not satisfied` — with the note "there
# are multiple different versions of crate `borsh` in the dependency graph` — actually means: pyth's type
# derives the trait through one copy of anchor-lang while our `#[account]` bounds ask for another. The
# program source is not wrong; the graph is. So the pin below is not a preference for an old version, it is
# "one copy, the one Anchor.toml's CLI matches".
#
# And the script refuses to hand over an unverified lock: `cargo check --workspace --all-targets` has to
# pass, because a lockfile committed by a bot that cannot compile is how a build gate becomes a rumour.
set -u

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

# `--precise` can legitimately fail when something in the graph cannot accept the version; the copy count
# and the compile below are what decide, so the message is recorded instead of swallowed or fatal.
for c in anchor-lang anchor-spl; do
  if out=$(cargo update -p "$c" --precise "$want" 2>&1); then
    echo "ok: $c -> $want"
  else
    printf '::warning::could not pin %s to %s: %s\n' "$c" "$want" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-240)"
  fi
done

# one `cargo tree` for all four counts: each invocation re-reads the graph, and a script that reports on
# the same resolution twice can report on two different ones if the registry moves in between.
tree=$(cargo tree -e normal,build --prefix none 2>/dev/null || true)
versions() { printf '%s\n' "$tree" | grep -oE "^$1 v[0-9][^ ]*" | sort -u; }
# lines, not words: each version is one `<crate> v<x.y.z>` pair, and `wc -w` on it said "2" for one copy
# — a count that gates a commit has to be the count of copies, not of tokens.
count() { versions "$1" | sed '/^$/d' | wc -l | tr -d ' '; }
echo "== copies in the resolved graph"
for c in anchor-lang anchor-spl borsh solana-program; do
  printf '   %-16s %s version(s): %s\n' "$c" "$(count "$c")" "$(versions "$c" | tr '\n' ' ')"
done
# Only anchor-lang is a hard invariant: more than one copy is the E0277 above returning, and no amount of
# "but it compiled last time" fixes it. borsh/solana-program legitimately coexist (mpl-core and switchboard
# are built against the newer ones, and that is also what ci.yml's `cargo tree -d` diagnostic says).
copies=$(count anchor-lang)
if [ "$copies" != "1" ]; then
  printf '::error::anchor-lang resolves to %s copies after the pin — pyth/mpl borsh bounds will not line up, so this lock is not worth committing\n' "$copies"
  exit 1
fi

echo "== proof: cargo check --workspace --all-targets"
if ! cargo check --workspace --all-targets; then
  echo "::error::the pinned graph does not compile — refusing to commit this Cargo.lock. The log says which crate; if it is the pyth/mpl borsh bound again, the fix is a version choice in this script, not an annotation in programs/."
  exit 1
fi

if ! grep -q '^name = "anchor-lang"' Cargo.lock; then
  echo "::error::no Cargo.lock with an anchor-lang entry — generate-lockfile wrote something unexpected"
  exit 1
fi

bytes=$(wc -c < Cargo.lock | tr -d ' ')
packages=$(grep -c '^name = ' Cargo.lock | tr -d ' ')
echo "ready: Cargo.lock ($bytes bytes, $packages packages, anchor-lang $want)"
# The step emits the workflow outputs from its own lines; this file is how it learns what was decided, and
# the fallback in the step is what makes "the script died before writing it" a different answer from
# "the script decided there is nothing to say".
printf '%s\n' "anchor-lang $want, $packages packages, $bytes bytes" > "${LOCK_SUMMARY:-/tmp/cargo-lock.summary}"
