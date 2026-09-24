"use strict";
// =============================================================================
// GUTTERCAPS economy — Cap Slam fight engine (shared by the arena server, the
// wager-battle resolver and the client's replay verifier)
// -----------------------------------------------------------------------------
// Pure and deterministic: everything random comes in through `roll(lane, side)`
// ∈ [0, 1), which the caller derives from the match seed (server matches:
// sha256(matchId ‖ nonceA ‖ nonceB ‖ serverSecret); wager battles: the
// Switchboard value pinned in `WagerBattle`). Anyone holding the seed can
// re-run `resolveFight` and get the identical round list — that is the whole
// fairness story, so keep this file free of Date/Math.random/IO.
//
// Rules (docs/02-economy.md §4):
//   - 3 lanes, best-of-3: lane i pits squadA[i] against squadB[i] in the order
//     the players submitted (lane order is the pre-match decision);
//   - effective power = chipPower × squad synergy × element edge × luck,
//     luck ~ U[1 − W, 1 + W] with W = ROUND_LUCK_WIDTH (0.5);
//   - the element edge (paint > steel > wheels > noise > shadow > paint) is
//     applied to side A as ×1.15 / ×0.87 — symmetric, since 1/1.15 ≈ 0.87;
//   - the match ends as soon as one side has two rounds.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.fightSquadPower = exports.fightChipPower = exports.onChainSquadPower = void 0;
exports.onChainChipPower = onChainChipPower;
exports.squadSynergy = squadSynergy;
exports.resolveFight = resolveFight;
exports.botSquad = botSquad;
const pvp_ts_1 = require("./pvp.ts");
const rarity_ts_1 = require("./rarity.ts");
/** arena::squad_power mirror: Σ floor(basePower × (10 000 + 250·(level − 1)) / 10 000). */
function onChainChipPower(rarity, level) {
    return Math.floor(((0, rarity_ts_1.profile)(rarity).basePower * (10_000 + 250 * (Math.max(1, level) - 1))) / 10_000);
}
const onChainSquadPower = (squad) => squad.reduce((s, c) => s + onChainChipPower(c.rarity, c.level), 0);
exports.onChainSquadPower = onChainSquadPower;
/** Float chip power used inside the fight (same as pvp.ts `chipPower`, keyed by collection index). */
const fightChipPower = (c) => (0, rarity_ts_1.profile)(c.rarity).basePower * (0, rarity_ts_1.levelMult)(c.level);
exports.fightChipPower = fightChipPower;
/** +8 % per pair of chips sharing an element (0, 1 or 2 pairs in a 3-squad). */
function squadSynergy(squad) {
    const elements = squad.map((c) => (0, pvp_ts_1.elementOfCollection)(c.collection));
    return 1 + 0.08 * (squad.length - new Set(elements).size);
}
/** Synergy-adjusted float power — the number `matchWinProbability` should be fed with. */
const fightSquadPower = (squad) => squad.reduce((s, c) => s + (0, exports.fightChipPower)(c), 0) * squadSynergy(squad);
exports.fightSquadPower = fightSquadPower;
function resolveFight(squadA, squadB, roll) {
    if (squadA.length !== 3 || squadB.length !== 3)
        throw new Error('a squad has exactly 3 chips');
    const synergyA = squadSynergy(squadA), synergyB = squadSynergy(squadB);
    const w = pvp_ts_1.ROUND_LUCK_WIDTH;
    const rounds = [];
    let winsA = 0, winsB = 0;
    for (let lane = 0; lane < 3 && winsA < 2 && winsB < 2; lane++) {
        const a = squadA[lane], b = squadB[lane];
        const edge = (0, pvp_ts_1.elementEdge)((0, pvp_ts_1.elementOfCollection)(a.collection), (0, pvp_ts_1.elementOfCollection)(b.collection));
        const rA = clamp01(roll(lane, 0)), rB = clamp01(roll(lane, 1));
        const luckA = 1 - w + 2 * w * rA;
        const luckB = 1 - w + 2 * w * rB;
        const effA = (0, exports.fightChipPower)(a) * synergyA * edge * luckA;
        const effB = (0, exports.fightChipPower)(b) * synergyB * luckB;
        const winner = effA >= effB ? 'A' : 'B';
        if (winner === 'A')
            winsA++;
        else
            winsB++;
        rounds.push({ lane, attacker: a.asset, defender: b.asset, elementEdge: round2(edge - 1), luckA: round4(luckA), luckB: round4(luckB), effA: Math.round(effA), effB: Math.round(effB), winner });
    }
    return { rounds, winner: winsA > winsB ? 'A' : 'B', winsA, winsB, powerA: (0, exports.onChainSquadPower)(squadA), powerB: (0, exports.onChainSquadPower)(squadB), synergyA: round2(synergyA), synergyB: round2(synergyB) };
}
const clamp01 = (x) => (Number.isFinite(x) ? Math.min(0.999_999_999, Math.max(0, x)) : 0);
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10_000) / 10_000;
/**
 * Bot squad for the 45 s fill: three chips whose on-chain squad power lands within ±3 % of
 * `targetPower` (so the bot is always in the player's league band and the fight is roughly even).
 * Rarities are chosen around the tier whose base power is closest to a third of the target, with a
 * little seeded variety (one tier up/down); levels are then solved per chip so the total matches.
 * `pick(i)` ∈ [0, 1) comes from the match seed so the bot is reproducible. Bots never pay out more
 * than the participation reward, so the remaining drift is cosmetic.
 */
function botSquad(targetPower, pick, tag = 'bot') {
    const target = Math.max(3 * (0, rarity_ts_1.profile)(0).basePower, targetPower);
    const per = target / 3;
    // a tier's reachable per-chip power is [basePower, basePower × levelMult(maxLevel)]
    const reach = (rs) => ({ lo: rs.reduce((s, r) => s + (0, rarity_ts_1.profile)(r).basePower, 0), hi: rs.reduce((s, r) => s + onChainChipPower(r, (0, rarity_ts_1.profile)(r).maxLevel), 0) });
    // base tier = highest rarity whose base power is ≤ per (levels only go up), bumped once if even
    // max levels cannot reach the target
    let base = 0;
    for (let r = 1; r < 9; r++)
        if ((0, rarity_ts_1.profile)(r).basePower <= per)
            base = r;
    if (reach([base, base, base]).hi < target && base < 8)
        base = (base + 1);
    const rarities = [0, 1, 2].map((i) => {
        const jitter = pick(i) < 0.25 && base > 0 ? -1 : pick(i) > 0.85 && base < 8 ? 1 : 0;
        return (base + jitter);
    });
    const band = pvp_ts_1.MATCHMAKING.powerBandsUpper.findIndex((u) => target < u);
    const floor = band > 0 ? pvp_ts_1.MATCHMAKING.powerBandsUpper[band - 1] : 0;
    const rs = (() => { const r0 = reach(rarities); return target >= r0.lo && target <= r0.hi ? rarities : [base, base, base]; })();
    const out = rs.map((r, i) => ({ asset: `${tag}-${i}`, collection: Math.floor(pick(i + 3) * 10) % 10, rarity: r, level: 1 }));
    // greedy level fill: raise the chip that keeps the total closest to the target until no step helps;
    // never cross the player's league ceiling (the replay would otherwise show a bot from the next band)
    const ceiling = (pvp_ts_1.MATCHMAKING.powerBandsUpper.find((u) => target < u) ?? Infinity) - 1;
    const total = () => (0, exports.onChainSquadPower)(out);
    // phase 1: reach the league floor at any cost (a bot one power point below the band would be a
    // different league in the replay); phase 2: approach the target while a step still helps
    for (let guard = 0; guard < 400; guard++) {
        const cur = total();
        const mustClimb = cur < floor;
        if (!mustClimb && cur >= target)
            break;
        let best = -1, bestGap = mustClimb ? Infinity : Math.abs(cur - target);
        for (let i = 0; i < 3; i++) {
            const c = out[i];
            if (c.level >= (0, rarity_ts_1.profile)(c.rarity).maxLevel)
                continue;
            const next = cur - onChainChipPower(c.rarity, c.level) + onChainChipPower(c.rarity, c.level + 1);
            if (next > ceiling)
                continue;
            const gap = Math.abs(next - target);
            if (gap < bestGap) {
                bestGap = gap;
                best = i;
            }
        }
        if (best < 0)
            break;
        out[best].level++;
    }
    return out;
}
