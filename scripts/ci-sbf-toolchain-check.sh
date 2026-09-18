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
# Exit:  0 the SBF cargo reads the graph · 1 it does not (names printed), or solana is present but no cargo
# could be found next to it (a discovery regression, which must not be green) · 2 there is no solana on PATH
# at all, so the question could not be asked (nothing was proven — the caller decides whether that is allowed;
# it is never allowed to look like a pass, so 2 is not 0).
set -u

# Arguments, in either order: an optional repo root (the convention this script has always had) and `--probe`,
# which prints the discovered toolchain as two machine-readable lines for scripts/ci-cargo-lock.sh. Parsing
# `--probe` as a directory would cd into a path that does not exist and exit 2 — a check that reports nothing
# at all, which a caller reading only "not 1" would take for a pass.
probe_only=""
root_arg=""
for a in "$@"; do
  case "$a" in
    --probe) probe_only=yes ;;
    *) [ -n "$root_arg" ] || root_arg=$a ;;
  esac
done

root=$(CDPATH= cd -- "${root_arg:-$(dirname -- "$0")/..}" && pwd) || exit 2
cd "$root" || exit 2

# Where the bundled cargo actually lives. The guess `active_release/cargo/bin/cargo` is what the *published*
# layout suggests, and run 61 proved it wrong in this image: the check printed "no cargo bundled next to
# …/active_release/bin/solana" and stepped aside, while `cargo build-sbf` four steps later was being run by a
# cargo 1.79 that exists somewhere under that same tree. So: walk the install directory for anything named
# `cargo`, and take the one that is *not* the cargo the shell would pick — that difference is the definition
# of "the toolchain the build uses", and it survives Agave moving the file.
#
# Resolved from `solana` on PATH rather than from a hardcoded /root path, so the same check can run on a
# workstation with an agave install; there it finds the real one or says so, instead of silently passing.
sol=$(command -v solana 2>/dev/null || true)
sbf_cargo=""
path_cargo_ver=$(cargo --version 2>/dev/null | head -1)
roots=""
if [ -n "$sol" ]; then
  # Roots to walk, in order of "this is where the platform tools live": the install directory two levels
  # above the solana binary, its `dist/` sibling (the layout agave uses when it unpacks platform tools),
  # and the installer root one level higher still. Deduplicated by awk because $HOME may equal /root and
  # then two of these are the same directory listed twice.
  b=$(dirname "$sol")
  for r in "$b/.." "$b/../dist" "$b/../.." "$HOME/.local/share/solana/install" /usr/local/lib/solana /usr/lib/solana; do
    [ -e "$r" ] || continue
    # `active_release` is a *symlink* the installer repoints on every update (run 62 said "no runnable cargo
    # was found under …/active_release" for a find that never followed it), so: resolve links in the root
    # itself AND ask find to follow the ones inside. Without -L a symlinked install is an empty tree.
    rr=$(CDPATH= cd -P "$r" 2>/dev/null && pwd) || continue
    roots="$roots
$rr"
  done
  roots=$(printf '%s\n' "$roots" | sed '/^$/d' | awk '!seen[$0]++')
  found=$(for r in $roots; do find -L "$r" -maxdepth 10 -type f -name cargo 2>/dev/null; done | head -40)
  for c in $found; do
    [ -x "$c" ] || continue
    v=$("$c" --version 2>/dev/null | head -1)
    [ -n "$v" ] || continue
    echo "discovered: $c — $v"
    if [ -z "$sbf_cargo" ]; then sbf_cargo=$c; fi          # fallback: the first one that answers
    if [ "$v" != "$path_cargo_ver" ]; then sbf_cargo=$c; break; fi   # preferred: not the shell's own
  done
fi
if [ -n "$probe_only" ]; then
  # Machine-readable form for scripts/ci-cargo-lock.sh, which drives the downgrade pass and needs both the
  # path and the version bound without parsing prose. Empty path = "there is nothing to ask".
  echo "sbf-cargo ${sbf_cargo:-}"
  echo "sbf-cargo-version ${sbf_cargo:+$($sbf_cargo --version 2>/dev/null | head -1 | sed -n 's/^[^ ]* \([0-9][^ ]*\).*/\1/p')}"
  exit 0
fi
if [ -z "$sbf_cargo" ]; then
  # Two different reasons, and the reader needs to know which: no `solana` on PATH at all (this is not an
  # agave-equipped runner — nothing to ask), versus a solana whose install tree contains no cargo (the layout
  # moved, and the discovery loop above needs to be widened). The second is a bug in this script; saying "."
  # for both hides it.
  # What was searched, and what is in it, printed rather than inferred. Run 61 hid a discovery bug behind
  # "no cargo bundled next to solana"; the same message with a listing of the tree is how the next layout
  # change names itself instead of costing another round. Bounded (maxdepth 2, head 20) so a toolchain tree
  # cannot blow the annotation budget.
  echo "== searched: $(printf '%s\n' "$roots" | tr '\n' ' ')"
  for r in $roots; do
    echo "-- $r"
    find -L "$r" -maxdepth 2 -name '*cargo*' 2>/dev/null | head -20
  done
  echo "-- cargo-build-sbf itself: $(command -v cargo-build-sbf 2>/dev/null || echo none)$(command -v cargo-build-sbf >/dev/null 2>&1 && printf ' (%s)' "$(cargo-build-sbf --version 2>&1 | head -1)")"
  if [ -z "$sol" ]; then
    echo "::notice title=sbf-toolchain-check::no solana on PATH — the SBF-readable-manifest question was NOT asked here (this is not a build image, or its toolchain is not on PATH)"
    exit 2
  fi
  # An agave install with no findable cargo is not "nothing to ask" — it is this script's discovery walk failing
  # against the image, and a gate that cannot see the graph in the one environment where the graph is built must
  # stop the job rather than be green next to an `::error` annotation nobody can reconcile with a pass.
  echo "::error title=sbf-toolchain-check::\`solana\` is at $sol but no runnable cargo was found in the install tree — the discovery walk in this script no longer matches the image layout, so the SBF graph question went unasked"
  exit 1
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
  # Anything that is not a manifest-parse failure is *not* this gate's verdict. `--locked` is the sharp end:
  # a lock written by the image's cargo 1.89 can be refused by 1.79 for reasons of lock format or target
  # resolution, and `anchor build` — which does not pass `--locked` and re-resolves happily — is the authority.
  # Run 60 learned this the expensive way: this step went red on such a refusal, `anchor build` never started,
  # and the surfacing step (which reads logs, not step names) accused the wrapper of a dash bug. So: warn,
  # print, and let the build below decide.
  echo "::warning title=sbf-toolchain-check::$ver answered something that is not \"failed to parse manifest\" — not treated as a verdict here; read the notes and let the anchor build below be the authority"
  sed -n '1,12p' "$err" | sed 's/^/note: /'
  rm -f "$err"
  exit 0
fi

for pkg in "$@"; do
  # No backticks in the command spelled out below: inside this double-quoted string they are a command
# substitution, and the first version of this line *ran* `gh workflow run lockfile.yml -f refresh=true`
# from inside a gate step — which is exactly what a "message" is not allowed to do.
echo "::error title=sbf-toolchain-check::$pkg is not readable by $ver — pin it down in scripts/ci-cargo-lock.sh (the SBFPINS list), then re-resolve with gh workflow run lockfile.yml -f refresh=true — the committed lock is valid, so the guard will not notice this on its own; the .so cannot be built from a lock the SBF toolchain's own cargo cannot parse"
done
sed -n '1,8p' "$err" | sed 's/^/note: /'
rm -f "$err"
exit 1
