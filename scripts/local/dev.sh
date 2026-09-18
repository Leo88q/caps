#!/usr/bin/env sh
# scripts/local/dev.sh — run GUTTERCAPS on your own machine, in tiers, one command each.
#
#   sh scripts/local/dev.sh ui         UI only, in-browser mock API — no backend, no Rust, ~1 min
#   sh scripts/local/dev.sh full       UI + backend API (indexer + REST on the same SQLite file)  [default]
#   sh scripts/local/dev.sh chain      programs + the localnet suite on LiteSVM (needs the Rust/Anchor toolchain)
#
# Env knobs:
#   PORT=<n>         client port                     (default 5173)
#   API_PORT=<n>     backend port                     (default 8787)
#   VALIDATOR=1      chain tier: run against solana-test-validator instead of LiteSVM (`npm run test:validator`)
#   SKIP_BUILD=1     chain tier: reuse target/deploy/*.so instead of rebuilding
#   SOLANA_RPC_URL=… full tier: RPC the backend indexes (default: the public devnet endpoint)
#
# What each tier actually does is in `docs/10-handoff-prompt.md` (local run) and `tests/localnet/README.md`.
# Everything below is the repo's own scripts — this file only checks the preconditions and wires them up.
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MODE=${1:-full}
PORT=${PORT:-5173}
API_PORT=${API_PORT:-8787}

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

check_node() {
  have node || die "node not found — install Node 22+ (https://nodejs.org, or: brew install node@22)"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
    || die "node $(node -v) is too old — the backend needs >= 22.13 (its package.json engines field says so)"
  note "node $(node -v) ✓"
}

# One `npm ci` for all three workspaces (root + client + backend + packages/economy): they share one
# lockfile, and a half-installed tree is the most common way a first local run goes wrong.
check_deps() {
  if [ -d "$ROOT/node_modules" ] && [ -d "$ROOT/client/node_modules" ] && [ -d "$ROOT/backend/node_modules" ]; then
    note "dependencies installed ✓"
    return
  fi
  say "npm ci (first run: a few minutes)"
  (cd "$ROOT" && npm ci) || die "npm ci failed — read the output above; do not 'npm install --force' over it"
}

wait_for_health() {
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -sf "http://127.0.0.1:$API_PORT/v1/health" >/dev/null 2>&1; then
      note "backend healthy ✓"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

run_ui() {
  say "UI only (in-browser mock API — no backend, no chain)"
  note "http://localhost:$PORT"
  cd "$ROOT" || die "cd $ROOT"
  VITE_API_MOCK=1 npm --prefix client run dev -- --port "$PORT"
}

run_full() {
  say "UI + backend API on one SQLite file"
  [ -z "${SOLANA_RPC_URL:-}" ] || note "SOLANA_RPC_URL=$SOLANA_RPC_URL"
  note "the backend's indexer needs RPC access; without it the API still serves, and the log says 'fetch failed'"
  cd "$ROOT/backend" || die "cd backend"
  PORT="$API_PORT" npm run serve &
  API_PID=$!
  # one trap, both exits: ^C in the foreground client must take the backend with it
  trap 'kill "$API_PID" 2>/dev/null' INT TERM EXIT
  if wait_for_health; then
    :
  else
    warn "backend did not answer /v1/health within 60 s — its log is above (the client falls back to the mock API)"
  fi
  say "client → http://localhost:$PORT   (API proxied to 127.0.0.1:$API_PORT)"
  cd "$ROOT" || die "cd $ROOT"
  VITE_DEV_API_TARGET="http://127.0.0.1:$API_PORT" npm --prefix client run dev -- --port "$PORT"
}

# Uses the toolchain the repo pins in Anchor.toml (anchor 0.31.1, solana 2.1.0) — see programs/README.md.
check_toolchain() {
  missing=""
  have anchor || missing="$missing anchor"
  have solana || missing="$missing solana"
  have cargo || missing="$missing cargo"
  have rustc || missing="$missing rustc"
  [ -z "$missing" ] || {
    warn "missing:$missing"
    cat <<'EOF'
    install, in this order (the versions are pinned by Anchor.toml and Cargo.lock):
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
      sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.0/install)"     # solana-cli 2.1.0
      cargo install --git https://github.com/solana-foundation/anchor --tag v0.31.1 anchor-cli --locked
    then re-run: sh scripts/local/dev.sh chain
EOF
    exit 1
  }
  note "anchor $(anchor --version 2>/dev/null | awk '{print $2}') · $(solana --version 2>/dev/null) · $(rustc --version) ✓"
}

run_chain() {
  say "programs + localnet suite (the same 83 scenarios CI runs)"
  check_toolchain
  cd "$ROOT" || die "cd $ROOT"
  if [ "${SKIP_BUILD:-}" = "1" ]; then
    note "SKIP_BUILD=1 — reusing target/deploy/*.so"
  else
    say "1/3 anchor build -- --features localnet"
    # The id in the localnet feature build must match chip_core::randomness::SB_PROGRAM_ID, and Anchor
    # takes it from this keypair — same two lines `run-validator.ts` does (tests/localnet/README.md).
    mkdir -p target/deploy
    cp tests/localnet/fixtures/sb_mock-keypair.json target/deploy/ || die "cp sb_mock-keypair.json"
    anchor build -- --features localnet || die "anchor build failed (docs/08 §4.1 lists the known first-build errors)"
  fi
  say "2/3 third-party fixtures (mpl_core from mainnet)"
  npm run localnet:fixtures || die "fixtures failed — needs network on the first run; 'rm -f tests/localnet/fixtures/*.so' if a cached one is damaged"
  if [ "${VALIDATOR:-}" = "1" ]; then
    say "3/3 solana-test-validator (KEEP_VALIDATOR=1: it stays up for a second run)"
    KEEP_VALIDATOR=1 npm run test:validator
  else
    say "3/3 npm test — LiteSVM in-process (set VALIDATOR=1 for a real validator instead)"
    npm test || die "suite failed — read the failing scenario, not the log tail"
  fi
  say "done"
}

case "$MODE" in
  ui)
    check_node; check_deps; run_ui ;;
  full | "")
    check_node; check_deps; run_full ;;
  chain)
    check_node; check_deps; run_chain ;;
  -h | --help | help)
    usage ;;
  *)
    warn "unknown mode: $MODE"
    usage 2 ;;
esac
