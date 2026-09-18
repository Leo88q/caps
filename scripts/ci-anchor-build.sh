#!/bin/sh
# ci-anchor-build.sh — run `anchor build` inside the pinned anchor container, with the two things the
# container needs and does not have by default. POSIX sh: a `container:` job's default shell is /bin/sh
# (dash), where bashisms are not "unsupported syntax to be polite about" but a step that dies at line 1.
#
# 1. A readable installer. `anchor build` takes `solana_version` from Anchor.toml and shells out to
#    `solana-install list` to switch to it. Two things are wrong with that in this image: agave 2.x renamed
#    the binary to `agave-install`, so the command does not exist; and the container's HOME has no installer
#    state, so even the renamed binary refuses to answer with `Unable to load
#    ~/.config/solana/install/config.yml` instead of reporting "nothing installed". Either way anchor dies
#    with "Failed to list installed `solana` versions" (exit 1) before compiling a single crate — a
#    toolchain-plumbing failure that looked exactly like a build failure. This script forwards the old name
#    to the new binary and writes the state file the installer wants — and then compares the pin against
#    what is active, instead of letting the CLI install the difference. That is not shyness about
#    downloads: the install anchor performs for an unmet `solana_version` runs
#    `info: uninstalling toolchain 'solana'` and takes the rustup link `cargo build-sbf` compiles through
#    with it, so the build died with exit 1 and no compiler output at all. A pin the environment cannot
#    satisfy is not a pin, it is a toolchain swap in the middle of a build; the fix is to align Anchor.toml
#    with the image (which is what this repo now does) and the script says so by name. It does not fake the
#    listing either way — a shim that always answers \"installed\" is how a version pin becomes a comment.
# 2. Everything the log needs. Whatever fails, the log is the only artefact that survives the trip out of
#    Actions (see ci-surface-log.sh), so toolchain identity goes into it before the build starts.
set -u

SHIM_DIR=${SHIM_DIR:-/tmp/shim}
ANCHOR_FEATURES=${ANCHOR_FEATURES:-localnet}

echo "== toolchain"
for t in solana solana-keypair anchor cargo rustc agave-install solana-install; do
  printf '   %-14s %s\n' "$t" "$(command -v "$t" 2>/dev/null || echo MISSING)"
done
printf '   shell: %s  HOME: %s\n' "$(readlink /proc/$$/exe 2>/dev/null || echo unknown)" "$HOME"
echo "== versions"
for t in "solana --version" "anchor --version" "cargo --version"; do
  printf '   %s\n' "$($t 2>&1 | head -1 || true)"
done

if ! command -v solana-install >/dev/null 2>&1; then
  if command -v agave-install >/dev/null 2>&1; then
    mkdir -p "$SHIM_DIR"
    # quoted delimiter: an unquoted heredoc would expand "$@" here, at the point of writing, and the
    # generated shim would forward nothing to agave-install (found by running this file under dash)
    cat > "$SHIM_DIR/solana-install" <<'SH'
#!/bin/sh
# agave renamed solana-install to agave-install; the anchor CLI still calls the old name.
exec agave-install "$@"
SH
    chmod +x "$SHIM_DIR/solana-install"
    PATH="$SHIM_DIR:$PATH"
    echo "shim: solana-install -> agave-install"
  else
    echo "::error::neither solana-install nor agave-install is on PATH — anchor build cannot check the pinned solana_version"
    exit 1
  fi
fi

# The installer's state. The image keeps solana under /root — that is its own answer to "what is installed"
# — while Actions points HOME at the workspace home, where no installer state exists and `agave-install
# list` refuses to answer rather than reporting an empty list. So: prefer /root's readable config (and export
# HOME so anchor's subprocesses look in the same place), and only then write the file. `json_rpc_url` is not
# decoration: the installer's parser requires it and dies with `missing field json_rpc_url`, which is how the
# first version of this fallback failed one line after fixing the problem it was written for.
install_dir="$HOME/.local/share/solana/install"
conf_dir="$HOME/.config/solana/install"
if [ ! -f "$conf_dir/config.yml" ] && [ -r /root/.config/solana/install/config.yml ]; then
  echo "installer: reading the image's own state (HOME=/root)"
  HOME=/root
  export HOME
  install_dir="$HOME/.local/share/solana/install"
  conf_dir="$HOME/.config/solana/install"
fi
if [ ! -f "$conf_dir/config.yml" ]; then
  if [ -d /root/.local/share/solana/install/active_release ] && [ ! -e "$install_dir/active_release" ]; then
    mkdir -p "$install_dir" 2>/dev/null || true
    ln -sfn /root/.local/share/solana/install/active_release "$install_dir/active_release" 2>/dev/null || true
  fi
  mkdir -p "$conf_dir" 2>/dev/null || true
  printf 'config_version: 1\njson_rpc_url: https://api.mainnet-beta.solana.com\nmetrics_url: localhost:8089\nupdate_check_in_seconds: 86400\nlast_update: %s\nsecrets: {}\nselected_release: %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$install_dir/active_release" > "$conf_dir/config.yml" 2>/dev/null \
    || echo "::warning::cannot write $conf_dir/config.yml — anchor will not be able to list installed solana versions"
fi

echo "== installed solana versions"
listing=$(solana-install list 2>&1)
printf '%s\n' "$listing" | head -5
want=$(sed -n 's/^solana_version *= *"\([^"]*\)".*/\1/p' Anchor.toml | head -1)
active=$(solana --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -n "$want" ]; then
  echo "== pin: solana_version $want (Anchor.toml [toolchain]), image has $active"
  if printf '%s\n' "$listing" | grep -qiE 'error|unable'; then
    # Loud, but not fatal. anchor will die with its own message right after this, and a script that exits
    # first replaces "here is why the installer is unusable" with a second mystery.
    echo "::warning::the solana installer cannot list versions: $(printf '%s' "$listing" | tr '\n\r' '  ' | cut -c1-200)"
  elif [ -n "$active" ] && [ "$active" != "$want" ]; then
    # This is the check that replaces "let anchor install the pinned version". It is not conservatism about
    # download time: the install ran, and it uninstalled the rustup `solana` toolchain link that
    # `cargo build-sbf` needs, so the build died with exit 1 and no compiler error anywhere in the log. A
    # pin the image cannot satisfy is not a pin, it is a toolchain swap in the middle of a build.
    printf '::error::Anchor.toml pins solana %s, this image has %s — align one of them (Anchor.toml, or the image tag in ci.yml) instead of letting anchor swap SDKs mid-build\n' "$want" "$active"
    exit 1
  else
    echo "   the image's solana is the pinned one — building with it as-is"
  fi
fi

# cargo's progress output is carriage-return-rewritten when anything treats the pipe like a
# terminal; in a captured log that buries the error line (run 44's tail was 800 bytes of it and no message)
CARGO_TERM_COLOR=never
CARGO_TERM_PROGRESS_WHEN=never
export CARGO_TERM_COLOR CARGO_TERM_PROGRESS_WHEN

if [ ! -f Cargo.lock ]; then
  # Worth a line because it is the reason this job can fail *before* our code is compiled: with no lock,
  # cargo resolves, and resolution parses the manifest of every candidate version — so one crate that
  # declares edition2024 is enough to stop a cargo older than 1.85 mid-download. This image is anchor's own
  # and ships cargo 1.79.0; `solanafoundation/anchor:v0.31.1` will not change that. The answer is the
  # committed lock the `cargo-lock` workflow writes (docs/09 §1.4), not a newer image we do not have.
  cver=$(cargo --version 2>&1 | head -1 || true)
  printf '::warning::no Cargo.lock in the tree — resolution runs on %s, which must parse the manifest of every candidate version; one crate on edition2024 aborts the job before a single local crate is compiled (the lock the cargo-lock workflow commits is the fix)\n' "$cver"
fi

echo "== anchor build -- --features $ANCHOR_FEATURES"
# exec, so cargo's exit code is this script's: the helper that captured this log reports what the build
# decided, and a wrapper that returns 0 because its last echo succeeded is how a red gate goes green.
exec anchor build -- --features "$ANCHOR_FEATURES"
