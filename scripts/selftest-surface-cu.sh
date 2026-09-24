#!/bin/sh
# Selftest for scripts/ci-surface-cu.ts (wired as `selftest:cu`): missing file, corrupt lines,
# empty input, a small JSONL table (human copy + one annotation + aggregated JSON), the 40-row
# cap, and the label normalizer in tests/localnet/helpers/cu.ts.
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
run() { node --no-warnings=ExperimentalWarning --import tsx scripts/ci-surface-cu.ts "$@" 2>&1; echo "rc=$?"; }
check() {
  case "$3" in *"$2"*) echo "ok   $1";; *) echo "FAIL $1: missing [$2] in [$3]"; fail=1;; esac
}

out=$(run /nonexistent/cu.jsonl); check "missing file" "missing or unreadable" "$out"; check "missing rc" "rc=0" "$out"
printf '{oops\nnot json\n' > /tmp/cu-bad.jsonl; out=$(run /tmp/cu-bad.jsonl); check "corrupt lines" "no transactions recorded" "$out"
printf '' > /tmp/cu-empty.jsonl; out=$(run /tmp/cu-empty.jsonl); check "empty" "no transactions recorded" "$out"
printf '%s\n' '{"key":"buy_pack","cu":412300,"sig":"s1","be":"litesvm"}' '{"key":"buy_pack","cu":380000,"sig":"s2","be":"litesvm"}' '{"key":"tick_day","cu":45120,"sig":"s3","be":"litesvm"}' > /tmp/cu-ok.jsonl
out=$(run /tmp/cu-ok.jsonl); check "table head" "CU census max-per-tx-shape (litesvm, 3 txs, 2 shapes)" "$out"
check "table row" "412300" "$out"; check "annotation" "::notice file=tests/localnet/helpers/cu.ts::CU census" "$out"
check "agg json" '"max": 412300' "$(cat target/cu-summary.json 2>/dev/null)"
node -e 'const r=[]; for (let i=0;i<60;i++) r.push(JSON.stringify({key:"k"+i,cu:1000+i,sig:"s",be:"litesvm"})); require("fs").writeFileSync("/tmp/cu-big.jsonl", r.join("\n")+"\n")'
out=$(run /tmp/cu-big.jsonl); check "cap" "20 more shapes in the cu-summary artifact" "$out"
norm=$(node --no-warnings=ExperimentalWarning --import tsx -e '
import("./tests/localnet/helpers/cu.ts").then((m) => {
  const cases = [
    ["buy_pack sku=standard qty=1 cur=SOL", "buy_pack"],
    ["open_compressed_pack #2", "open_compressed_pack"],
    ["chip_core: pauser pauses", "pauser pauses"],
    ["init_emission (future genesis)", "init_emission"],
    ["cancel compressed claim 3", "cancel compressed claim"],
    ["fuse_claims_commit nonce=99", "fuse_claims_commit"],
    [undefined, "unlabeled"],
  ];
  let bad = 0;
  for (const [input, want] of cases) {
    const got = m.normalizeCuLabel(input);
    if (got !== want) { console.error("MISMATCH " + JSON.stringify(input) + " -> " + got + ", want " + want); bad = 1; }
  }
  if (!bad) console.log("normalize-ok");
});' 2>&1)
check "normalizer" "normalize-ok" "$norm"
[ "$fail" = 0 ] && echo "selftest ok: ci-surface-cu.ts — 5 scenarios + normalizer" || { echo "selftest FAILED"; exit 1; }
