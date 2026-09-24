#!/bin/sh
# Selftest for scripts/ci-surface-cu.ts + tests/localnet/helpers/cu.ts (wired as `selftest:cu`):
# missing file, corrupt lines, empty input, a small JSONL table (human copy + one annotation +
# aggregated JSON), the 60-row cap, tx-shape key derivation (discriminator map, repeats, native
# programs, fallbacks), and ix-name coverage against the client/spec sources.
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
run() { node --no-warnings=ExperimentalWarning --import tsx scripts/ci-surface-cu.ts "$@" 2>&1; echo "rc=$?"; }
check() {
  case "$3" in *"$2"*) echo "ok   $1";; *) echo "FAIL $1: missing [$2] in [$3]"; fail=1;; esac
}

out=$(run /nonexistent/cu.jsonl); check "missing file" "missing log or all lines corrupt" "$out"; check "missing rc" "rc=0" "$out"
printf '{oops\nnot json\n' > /tmp/cu-bad.jsonl; out=$(run /tmp/cu-bad.jsonl); check "corrupt lines" "no transactions recorded" "$out"
printf '' > /tmp/cu-empty.jsonl; out=$(run /tmp/cu-empty.jsonl); check "empty" "no transactions recorded" "$out"
printf '%s\n' '{"key":"buy_pack","cu":412300,"sig":"s1","be":"litesvm","label":"buy_pack sku=x"}' '{"key":"buy_pack","cu":380000,"sig":"s2","be":"litesvm"}' '{"key":"tick_day","cu":45120,"sig":"s3","be":"litesvm"}' > /tmp/cu-ok.jsonl
out=$(run /tmp/cu-ok.jsonl); check "table head" "CU census max-per-tx-shape (litesvm, 3 txs, 2 shapes)" "$out"
check "table row" "412300" "$out"; check "annotation" "::notice file=tests/localnet/helpers/cu.ts::CU census" "$out"
check "agg json" '"max": 412300' "$(cat target/cu-summary.json 2>/dev/null)"
node -e 'const r=[]; for (let i=0;i<70;i++) r.push(JSON.stringify({key:"k"+i,cu:1000+i,sig:"s",be:"litesvm"})); require("fs").writeFileSync("/tmp/cu-big.jsonl", r.join("\n")+"\n")'
out=$(run /tmp/cu-big.jsonl); check "cap" "10 more shapes in the cu-summary artifact" "$out"
keys=$(node --no-warnings=ExperimentalWarning --import tsx -e '
Promise.all([import("./tests/localnet/helpers/cu.ts"), import("@solana/web3.js"), import("node:crypto"), import("node:fs")]).then(([cu, web3, crypto, fs]) => {
  const disc = (name) => crypto.createHash("sha256").update("global:" + name, "utf8").digest().subarray(0, 8);
  const anchorIx = (name) => new web3.TransactionInstruction({ programId: web3.Keypair.generate().publicKey, keys: [], data: Buffer.from(disc(name)) });
  const nativeIx = (pid, bytes) => new web3.TransactionInstruction({ programId: new web3.PublicKey(pid), keys: [], data: Buffer.from(bytes) });
  const SYS = "11111111111111111111111111111111", CB = "ComputeBudget111111111111111111111111111111";
  const bad = [];
  const eq = (got, want, what) => { if (got !== want) bad.push(what + ": got [" + got + "] want [" + want + "]"); };
  eq(cu.cuKeyForIxs([anchorIx("buy_pack")]), "buy_pack", "single");
  eq(cu.cuKeyForIxs([anchorIx("init_randomness"), anchorIx("buy_pack")]), "init_randomness+buy_pack", "combo");
  eq(cu.cuKeyForIxs([anchorIx("reveal_randomness"), anchorIx("open_pack"), anchorIx("open_pack"), anchorIx("open_pack")]), "reveal_randomness+open_pack×3", "repeat-collapse");
  eq(cu.cuKeyForIxs([nativeIx(CB, [2, 0, 0, 0, 0]), anchorIx("tick_day")]), "tick_day", "compute-skipped");
  eq(cu.cuKeyForIxs([nativeIx(SYS, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]), "sys:transfer", "system-transfer");
  eq(cu.cuKeyForIxs([nativeIx("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", [3, 1, 2])]), "spl:transfer", "token-transfer");
  const unk = cu.cuKeyForIxs([nativeIx(web3.Keypair.generate().publicKey.toBase58(), [9, 9, 9, 9, 9, 9, 9, 9])]);
  if (!unk.startsWith("?disc:")) bad.push("unknown-disc fallback: got [" + unk + "]");
  eq(cu.cuKeyForIxs([]), "empty", "empty");
  // coverage: every ixData()/emissionAdmin()/compressedBattleV2Data() literal in source must resolve
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = d + "/" + e.name; if (e.isDirectory()) walk(p); else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) files.push(p); } };
  walk("client/src/chain"); walk("tests/localnet");
  const lits = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:ixData|Admin|V2Data)\(\s*\x27([a-z_0-9]+)\x27/g)) lits.add(m[1]);
  }
  const names = new Set(cu.CU_IX_NAMES);
  for (const lit of [...lits].sort()) {
    if (!names.has(lit)) bad.push("unmapped literal: " + lit);
    else if (cu.cuIxNameForDisc(Buffer.from(disc(lit)).toString("hex")) !== lit) bad.push("disc mismatch: " + lit);
  }
  for (const v of ["reveal_randomness", "reveal_battle_randomness", "create_battle_v2", "accept_battle_v2", "set_oracles", "set_split"]) {
    if (!names.has(v)) bad.push("missing variable-passed name: " + v);
  }
  if (bad.length) { console.error(bad.join("\n")); process.exitCode = 1; }
  else console.log("keys-ok (" + lits.size + " literals, " + names.size + " names)");
});' 2>&1)
check "key derivation + coverage" "keys-ok" "$keys"
[ "$fail" = 0 ] && echo "selftest ok: ci-surface-cu.ts + cu.ts — 5 scenarios + key derivation + coverage" || { echo "selftest FAILED"; exit 1; }
