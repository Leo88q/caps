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
#    to the new binary and writes the state file the installer wants, then lets the CLI do its own job: if
#    the pinned version is genuinely absent, anchor installs it, which is what a pin is for. It does not
#    fake the listing — a shim that always answers "installed" is how a version pin becomes a comment.
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
if [ -n "$want" ]; then
  echo "== pin: solana_version $want (Anchor.toml [toolchain])"
  if printf '%s\n' "$listing" | grep -q "$want"; then
    echo "   installed — the build uses it"
  elif printf '%s\n' "$listing" | grep -qiE 'error|unable'; then
    # Loud, but not fatal. anchor will die with its own message right after this, and a script that exits
    # first replaces "here is why the installer is unusable" with a second mystery.
    echo "::warning::the solana installer cannot list versions: $(printf '%s' "$listing" | tr '\n\r' '  ' | cut -c1-200)"
  else
    echo "::notice::$want is not installed — anchor build will fetch it now (the job caches the installer dir, so this costs a download once per pin rather than once per run)"
  fi
fi

echo "== anchor build -- --features $ANCHOR_FEATURES"
# exec, so cargo's exit code is this script's: the helper that captured this log reports what the build
# decided, and a wrapper that returns 0 because its last echo succeeded is how a red gate goes green.
exec anchor build -- --features "$ANCHOR_FEATURES"
