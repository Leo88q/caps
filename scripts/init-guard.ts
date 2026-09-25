// SEC-F7 — first-caller-wins initialisation guard for `npm run setup` (scripts/setup.ts).
//
// chip_core `initialize`, arena `init_arena` and staking `init_emission` create singleton PDAs
// (`["config"]`, `["arena_config"]`, `["emission"]`) and make THE CALLER the admin. The programs do
// not check the upgrade authority, so between `solana program deploy` and `npm run setup` anyone can
// front-run the init with their own admin / treasury. `init_emission` is additionally protected by
// the $CG mint authority (the attacker cannot hand it over), the other two are not.
//
// Before this guard, setup.ts printed «config exists — skip» and carried on, i.e. a hijacked config
// would have been adopted silently. Now an existing singleton must belong to us: its current admin is
// the deployer wallet or one of the keys in SETUP_EXPECTED_ADMINS (e.g. the Squads multisig after the
// admin hand-over). Anything else aborts —
// the only recovery is a redeploy under fresh program ids, which is cheap BEFORE launch.
//
// Pure (base58 strings + bytes, no web3 import) so tests/security/init-guard.test.ts runs under
// `node --experimental-strip-types` with no dependencies.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58 of a 32-byte key (same output as PublicKey#toBase58). */
export function b58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

export type Singleton = 'chip_core config' | 'arena config' | 'staking emission';

/** Byte layout of the fields we check (8-byte Anchor discriminator first; see the #[account] structs under programs/). */
const LAYOUT: Record<Singleton, { admin: number; pendingAdmin?: number; treasury?: number; buyback?: number }> = {
  'chip_core config': { admin: 8, pendingAdmin: 40, treasury: 72, buyback: 104 }, // GameConfig { admin, pending_admin, treasury, buyback_wallet, … }
  'arena config': { admin: 8 },                                                     // ArenaConfig { admin, battle_oracle, … }
  'staking emission': { admin: 8 },                                                  // EmissionState { admin, cg_mint, … }
};

const ZERO = '11111111111111111111111111111111';

export interface InitGuardExpect {
  /** deployer wallet + SETUP_EXPECTED_ADMINS */
  allowedAdmins: string[];
  treasury?: string;
  buyback?: string;
}

export interface InitGuardVerdict { ok: boolean; problems: string[]; warnings: string[]; admin: string }

/** Decide whether an already-initialised singleton is ours. `data` = raw account data. */
export function assessExistingSingleton(kind: Singleton, data: Uint8Array, expect: InitGuardExpect): InitGuardVerdict {
  const l = LAYOUT[kind];
  const need = Math.max(l.admin, l.pendingAdmin ?? 0, l.treasury ?? 0, l.buyback ?? 0) + 32;
  if (data.length < need) return { ok: false, problems: [`${kind}: account is ${data.length} bytes, expected ≥ ${need} — not the account this script created`], warnings: [], admin: '' };
  const key = (o: number) => b58(data.subarray(o, o + 32));
  const allowed = new Set(expect.allowedAdmins);
  const admin = key(l.admin);
  const pending = l.pendingAdmin !== undefined ? key(l.pendingAdmin) : ZERO;
  const problems: string[] = [];
  const warnings: string[] = [];
  // pending_admin deliberately does NOT count: an attacker who front-ran the init could propose US as the
  // pending admin to make this check pass while he stays admin (and keeps his treasury) until we accept.
  if (!allowed.has(admin)) {
    problems.push(
      `${kind} already exists with admin ${admin}${pending !== ZERO ? ` (pending ${pending})` : ''}, which is neither the deployer wallet nor in SETUP_EXPECTED_ADMINS ` +
      `— somebody initialised it first (SEC-F7). Do NOT adopt it: redeploy under fresh program ids (npm run program-ids -- new / apply) and rerun setup.`,
    );
  }
  if (l.treasury !== undefined && expect.treasury && key(l.treasury) !== expect.treasury) {
    warnings.push(`${kind}: treasury on chain ${key(l.treasury)} ≠ expected ${expect.treasury} (fine only if it was changed on purpose via set_params)`);
  }
  if (l.buyback !== undefined && expect.buyback && key(l.buyback) !== expect.buyback) {
    warnings.push(`${kind}: buyback wallet on chain ${key(l.buyback)} ≠ expected ${expect.buyback} (fine only if it was changed on purpose via set_params)`);
  }
  return { ok: problems.length === 0, problems, warnings, admin };
}

/** Parse SETUP_EXPECTED_ADMINS (comma / whitespace separated base58 keys). */
export function expectedAdminsFromEnv(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
