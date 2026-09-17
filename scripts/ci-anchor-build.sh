#!/bin/sh
# ci-anchor-build.sh — run `anchor build` inside the pinned anchor container, with the two things the
# container needs and does not have by default. POSIX sh: a `container:` job's default shell is /bin/sh
# (dash), where bashisms are not "unsupported syntax to be polite about" but a step that dies at line 1.
#
# 1. solana-install. `anchor build` reads the pinned `solana_version` out of Anchor.toml and shells out to
#    `solana-install list` to switch to it. Agave 2.x renamed that installer to `agave-install`, so the CLI
#    died with "Error: Failed to list installed `solana` versions" (exit 1) without compiling a single
#    crate — an anchor-vs-agave naming mismatch, not a build failure. Forwarding the old name to the new
#    binary keeps the version pin meaningful: the installer still has to report the pinned version as
#    installed, and if it does not, anchor installs it, which is the behaviour the pin asks for.
# 2. Everything the log needs. Whatever fails, the log is the only artefact that survives the trip out of
#    Actions (see ci-surface-log.sh), so the toolchain identity goes into it before the build starts.
set -u

SHIM_DIR=${SHIM_DIR:-/tmp/shim}
ANCHOR_FEATURES=${ANCHOR_FEATURES:-localnet}

echo "== toolchain"
for t in solana solana-keypair anchor cargo rustc agave-install solana-install; do
  printf '   %-14s %s\n' "$t" "$(command -v "$t" 2>/dev/null || echo MISSING)"
done
printf '   shell: %s\n' "$(readlink /proc/$$/exe 2>/dev/null || echo unknown)"
echo "== versions"
for t in "solana --version" "anchor --version" "cargo --version"; do
  printf '   %s\n' "$($t 2>&1 | head -1 || true)"
done

if ! command -v solana-install >/dev/null 2>&1; then
  if command -v agave-install >/dev/null 2>&1; then
    mkdir -p "$SHIM_DIR"
    # quoted delimiter: an unquoted heredoc would expand "$@" here, at the point of writing, and the
    # generated shim would forward nothing to agave-install (found by running this file under dash).
    cat > "$SHIM_DIR/solana-install" <<'SH'
#!/bin/sh
# agave renamed solana-install to agave-install; the anchor CLI still calls the old name.
exec agave-install "$@"
SH
    chmod +x "$SHIM_DIR/solana-install"
    PATH="$SHIM_DIR:$PATH"
    echo "shim: solana-install -> agave-install"
  else
    echo "::warning::neither solana-install nor agave-install is on PATH — anchor build cannot verify the pinned solana_version"
  fi
fi
echo "== installed solana versions"
(solana-install list 2>&1 || echo "installer unavailable") | head -5

echo "== anchor build -- --features $ANCHOR_FEATURES"
# exec, so cargo's exit code is this script's: the helper that captured this log reports what the build
# decided, and a wrapper that returns 0 because its last echo succeeded is how a red gate goes green.
exec anchor build -- --features "$ANCHOR_FEATURES"
