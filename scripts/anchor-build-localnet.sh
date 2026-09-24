#!/bin/sh
# anchor-build-localnet.sh — build the five programs with `--features localnet` (SB_PROGRAM_ID = sb_mock) on a
# developer machine. The CI counterpart is scripts/ci-anchor-build.sh; this one exists because the same three
# environment traps bite locally, and every one of them reads like a compile error without being one:
#
#   1. sb_mock's id is pinned. chip_core under `--features localnet` accepts randomness accounts owned by
#      SB_PROGRAM_ID = ApDh35…, `[programs.localnet] sb_mock` names the same key, and the suite loads the mock
#      at it — all three are the committed tests/localnet/fixtures/sb_mock-keypair.json, and `anchor build`
#      reads the program id from target/deploy/sb_mock-keypair.json, fabricating a keypair when it is absent
#      (tests/localnet/run-validator.ts copies the fixture for the same reason). So the fixture is installed
#      whenever target/deploy does not already hold exactly that file.
#   2. agave renamed `solana-install` to `agave-install`, and the anchor CLI still calls the old name to read
#      `[toolchain] solana_version`. On a machine with only the new binary — or one whose installer state
#      (~/.config/solana/install/config.yml) is absent — the build dies with "Failed to list installed
#      `solana` versions" before a single crate is compiled. This script puts the shim on PATH for the build
#      and writes the state file the listing needs when it is missing — or present but unreadable
#      (a newer installer drops `json_rpc_url`; the old schema is regenerated, the previous file kept
#      as config.yml.bak — the old schema is a superset the new installer still accepts).
#   3. anchor *installs* a pinned solana_version it does not see installed, and that install removes the
#      rustup `solana` toolchain link `cargo build-sbf` compiles through: exit 1, no compiler output
#      (docs/09 §3.5, run 44). So the pin is compared with the active CLI first and the script stops with the
#      command that switches versions on purpose, instead of letting anchor swap SDKs in the middle of a build.
#
#   npm run localnet:build                     # = sh scripts/anchor-build-localnet.sh
#   ANCHOR_FEATURES=devnet npm run localnet:build
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
FEATURES=${ANCHOR_FEATURES:-localnet}
SHIM_DIR=target/.shim
KP_SRC=tests/localnet/fixtures/sb_mock-keypair.json
KP_DST=target/deploy/sb_mock-keypair.json

echo "== toolchain"
for t in anchor cargo rustc solana solana-install agave-install avm; do
  printf '   %-15s %s\n' "$t" "$(command -v "$t" 2>/dev/null || echo MISSING)"
done
for v in anchor solana cargo; do
  if command -v "$v" >/dev/null 2>&1; then
    printf '   %-15s %s\n' "$v" "$("$v" --version 2>&1 | head -1 || true)"
  fi
done

if ! command -v anchor >/dev/null 2>&1; then
  echo "error: anchor is not on PATH — programs/README.md has the one-time setup (rust 1.89.0 from rust-toolchain.toml, anchor 0.31.1, solana 2.1.0)"
  exit 1
fi

if [ "$FEATURES" = localnet ]; then
  if [ ! -f "$KP_SRC" ]; then
    echo "error: $KP_SRC is missing — it is the keypair that pins sb_mock's id"
    exit 1
  fi
  mkdir -p target/deploy
  if [ ! -f "$KP_DST" ]; then
    cp "$KP_SRC" "$KP_DST"
    echo "keypair: $KP_DST <- $KP_SRC"
  elif ! cmp -s "$KP_SRC" "$KP_DST"; then
    cp "$KP_SRC" "$KP_DST"
    echo "keypair: $KP_DST replaced — a plain 'anchor build' had fabricated another id there"
  fi
fi

if ! command -v solana-install >/dev/null 2>&1; then
  if command -v agave-install >/dev/null 2>&1; then
    mkdir -p "$SHIM_DIR"
    # A quoted heredoc delimiter: an unquoted one would expand "$@" here, at the point of writing, and the
    # generated shim would forward nothing to agave-install (the same mistake scripts/ci-anchor-build.sh records)
    cat > "$SHIM_DIR/solana-install" <<'SH'
#!/bin/sh
# agave renamed solana-install to agave-install; the anchor CLI still calls the old name.
exec agave-install "$@"
SH
    chmod +x "$SHIM_DIR/solana-install"
    PATH="$ROOT/$SHIM_DIR:$PATH"
    export PATH
    echo "shim: solana-install -> agave-install ($SHIM_DIR, this build only)"
  else
    echo "error: neither solana-install nor agave-install is on PATH — the anchor CLI uses it to read [toolchain] solana_version (programs/README.md, step 3)"
    exit 1
  fi
fi

# The installer's state. A machine that never ran `agave-install init` has no config.yml, and then even the
# renamed binary refuses to answer instead of reporting "nothing installed" ("Unable to load
# ~/.config/solana/install/config.yml"). `json_rpc_url` is not decoration: the parser requires it and dies with
# `missing field json_rpc_url` without it. Written when absent or unreadable (then the old file is kept as config.yml.bak), and nothing else on the machine is touched.
conf_dir="$HOME/.config/solana/install"
if [ ! -f "$conf_dir/config.yml" ] || ! grep -q 'json_rpc_url' "$conf_dir/config.yml" 2>/dev/null; then
  if [ -f "$conf_dir/config.yml" ]; then
    cp "$conf_dir/config.yml" "$conf_dir/config.yml.bak" 2>/dev/null || true
    echo "installer: $conf_dir/config.yml lacks json_rpc_url (new-installer schema?) — backed up to config.yml.bak, regenerating"
  fi
  mkdir -p "$conf_dir" 2>/dev/null || true
  printf 'config_version: 1\njson_rpc_url: https://api.mainnet-beta.solana.com\nmetrics_url: localhost:8089\nupdate_check_in_seconds: 86400\nlast_update: %s\nsecrets: {}\nselected_release: %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HOME/.local/share/solana/install/active_release" > "$conf_dir/config.yml" 2>/dev/null || true
  if [ -f "$conf_dir/config.yml" ]; then
    echo "installer: wrote $conf_dir/config.yml (the listing anchor performs refuses to answer without it)"
  else
    echo "warning: cannot write $conf_dir/config.yml — if the build stops on 'Failed to list installed solana versions', that file is why"
  fi
fi

echo "== installed solana versions"
solana-install list 2>&1 | head -5 || true
want=$(sed -n 's/^solana_version *= *"\([^"]*\)".*/\1/p' Anchor.toml | head -1)
active=$(solana --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -n "$want" ] && [ -n "$active" ] && [ "$active" != "$want" ]; then
  echo "error: Anchor.toml pins solana $want ([toolchain] solana_version), this machine has $active active."
  echo "       Switch on purpose, then re-run — do not let anchor install it mid-build:"
  echo "         avm solana install $want      # avm-managed (the usual macOS setup)"
  echo "         agave-install init $want      # plain agave installer"
  echo "       anchor's own install path removes the rustup 'solana' toolchain link cargo build-sbf needs, so it"
  echo "       ends in exit 1 with no compiler output (docs/09 §3.5, run 44)."
  exit 1
fi
if [ -n "$want" ]; then
  echo "pin: solana_version $want (Anchor.toml) == $active active"
fi

echo "== anchor build -- --features $FEATURES"
# exec, so cargo's exit code is this script's — a wrapper that returns 0 because its last echo succeeded is how
# a red build goes green.
exec anchor build -- --features "$FEATURES"
