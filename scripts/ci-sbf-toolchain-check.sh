#!/bin/sh
# ci-sbf-toolchain-check.sh — ask the cargo that will really build the .so whether it can read this lock.
#
# Why this exists at all: `anchor build` does not compile with the image's cargo. `cargo build-sbf` puts the
# cargo *bundled in the Agave release* first on PATH (for `solana-cli 2.1.0`, that is cargo 1.79.0, August
# 2024), and a cargo that cannot parse one manifest dies before the compiler sees a single line of ours:
#
#   error: failed to parse manifest at `/root/.cargo/registry/src/…/getrandom-0.4.3/Cargo.toml`
#   Caused by: feature `edition2024` is required … not stabilized in this version of Cargo (1.79.0)
#
# That cost a run of CI and pointed at nothing actionable, and it is not a one-off: `edition2024` is now
# ordinary for new releases, so any dependency bump can bring it back — which is why the answer here is a
# check, not just one pin. A lockfile committed by a job that only ever asked cargo 1.89 is a lockfile three
# crates deep in "works on my machine", so scripts/ci-cargo-lock.sh calls this before committing, and
# ci.yml's `programs` job calls it before the four-minute `anchor build` it would otherwise waste.
#
# Usage: sh scripts/ci-sbf-toolchain-check.sh [<manifest-dir>]
# Exit:  0 the SBF cargo reads the graph · 1 it does not (names printed) · 2 the SBF cargo is not in this
# image (nothing was proven — the caller decides whether that is allowed; it is never allowed to look like a
# pass, so 2 is not 0).
set -u

root=$(CDPATH= cd -- "${1:-$(dirname -- "$0")/..}" && pwd) || exit 2
cd "$root" || exit 2

# The Agave layout is <install>/active_release/bin/solana and <install>/active_release/cargo/bin/cargo.
# Resolve through `solana` on PATH rather than hardcoding /root/.local/share: the same check is meant to be
# runnable on a workstation with an agave toolchain, and a hardcoded path would silently pass there by
# finding nothing.
sol=$(command -v solana 2>/dev/null || true)
sbf_cargo=""
if [ -n "$sol" ]; then
  # readlink -f is GNU-only; dash's `dirname` chain works everywhere and `solana` is a real binary in
  # active_release/bin, not a symlink, so two dirnames is all the walk this layout needs.
  bin=$(dirname "$sol")
  rel=$(dirname "$bin")
  for c in "$rel/cargo/bin/cargo" "$bin/../cargo/bin/cargo"; do
    if [ -x "$c" ]; then sbf_cargo=$c; break; fi
  done
fi
if [ -z "$sbf_cargo" ]; then
  echo "::notice title=sbf-toolchain-check::no cargo bundled next to $(command -v solana 2>/dev/null || echo 'the solana on PATH') — the SBF-readable-manifest question was NOT asked here"
  exit 2
fi

ver=$("$sbf_cargo" --version 2>/dev/null | head -1)
echo "== the cargo that builds the .so: $sbf_cargo ($ver)"

err=$(mktemp)
if "$sbf_cargo" metadata --locked --format-version 1 >/dev/null 2>"$err"; then
  echo "ok: $ver parses every manifest in this lock (no edition or feature it cannot read)"
  rm -f "$err"
  exit 0
fi

# Cargo stops at the first unparseable manifest, so the message is written for the reader to act on it once:
# crate and version taken out of the path, and the fix named as what it is (a version choice in the lock, not
# a code change). Anything cargo complains about that is *not* a manifest-parse failure is printed verbatim
# and left alone — a `--locked` refusal (the lock does not match the manifests) is a different problem and
# deserves its own text, not this script's.
set --
while IFS= read -r line; do
  case "$line" in
    *"failed to parse manifest at "*)
      path=$(printf '%s' "$line" | sed -e 's/.*manifest at `//' -e 's/`.*//')
      pkg=$(basename "$(dirname "$path")")
      set -- "$@" "$pkg"
      ;;
  esac
done <"$err"

if [ "$#" = 0 ]; then
  echo "::error title=sbf-toolchain-check::$ver could not read this lock for a reason that is not a manifest version — see the log (a --locked mismatch means the committed lock disagrees with the manifests; anything else means this script needs a new check)"
  sed -n '1,12p' "$err" | sed 's/^/note: /'
  rm -f "$err"
  exit 1
fi

for pkg in "$@"; do
  echo "::error title=sbf-toolchain-check::$pkg is not readable by $ver — pin it down in scripts/ci-cargo-lock.sh (the SBFPINS list), then re-resolve with `gh workflow run lockfile.yml -f refresh=true` — the committed lock is valid, so the guard will not notice this on its own; the .so cannot be built from a lock the SBF toolchain's own cargo cannot parse"
done
sed -n '1,8p' "$err" | sed 's/^/note: /'
rm -f "$err"
exit 1
