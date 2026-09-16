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

import { ROUND_LUCK_WIDTH, elementEdge, elementOfCollection } from './pvp.ts';
import { levelMult, profile, type RarityIndex } from './rarity.ts';

export interface FighterChip {
  asset: string;
  collection: number; // on-chain collection index 0..9
  rarity: number;     // 0..8
  level: number;      // ≥ 1
}

export interface FightRound {
  lane: number;
  attacker: string;   // squadA[lane].asset
  defender: string;   // squadB[lane].asset
  /** element edge for side A as a delta: +0.15 / −0.13 / 0 (the client renders 1 + elementEdge) */
  elementEdge: number;
  luckA: number;
  luckB: number;
  effA: number;
  effB: number;
  winner: 'A' | 'B';
}

export interface FightResult {
  rounds: FightRound[];
  winner: 'A' | 'B';
  winsA: number;
  winsB: number;
  /** on-chain integer squad power (league bands, wager escrow) */
  powerA: number;
  powerB: number;
  synergyA: number;
  synergyB: number;
}

/** arena::squad_power mirror: Σ floor(basePower × (10 000 + 250·(level − 1)) / 10 000). */
export function onChainChipPower(rarity: number, level: number): number {
  return Math.floor((profile(rarity as RarityIndex).basePower * (10_000 + 250 * (Math.max(1, level) - 1))) / 10_000);
}
export const onChainSquadPower = (squad: readonly FighterChip[]): number => squad.reduce((s, c) => s + onChainChipPower(c.rarity, c.level), 0);

/** Float chip power used inside the fight (same as pvp.ts `chipPower`, keyed by collection index). */
export const fightChipPower = (c: FighterChip): number => profile(c.rarity as RarityIndex).basePower * levelMult(c.level);

/** +8 % per pair of chips sharing an element (0, 1 or 2 pairs in a 3-squad). */
export function squadSynergy(squad: readonly FighterChip[]): number {
  const elements = squad.map((c) => elementOfCollection(c.collection));
  return 1 + 0.08 * (squad.length - new Set(elements).size);
}

/** Synergy-adjusted float power — the number `matchWinProbability` should be fed with. */
export const fightSquadPower = (squad: readonly FighterChip[]): number => squad.reduce((s, c) => s + fightChipPower(c), 0) * squadSynergy(squad);

export type Roll = (lane: number, side: 0 | 1) => number;

export function resolveFight(squadA: readonly FighterChip[], squadB: readonly FighterChip[], roll: Roll): FightResult {
  if (squadA.length !== 3 || squadB.length !== 3) throw new Error('a squad has exactly 3 chips');
  const synergyA = squadSynergy(squadA), synergyB = squadSynergy(squadB);
  const w = ROUND_LUCK_WIDTH;
  const rounds: FightRound[] = [];
  let winsA = 0, winsB = 0;
  for (let lane = 0; lane < 3 && winsA < 2 && winsB < 2; lane++) {
    const a = squadA[lane], b = squadB[lane];
    const edge = elementEdge(elementOfCollection(a.collection), elementOfCollection(b.collection));
    const rA = clamp01(roll(lane, 0)), rB = clamp01(roll(lane, 1));
    const luckA = 1 - w + 2 * w * rA;
    const luckB = 1 - w + 2 * w * rB;
    const effA = fightChipPower(a) * synergyA * edge * luckA;
    const effB = fightChipPower(b) * synergyB * luckB;
    const winner: 'A' | 'B' = effA >= effB ? 'A' : 'B';
    if (winner === 'A') winsA++; else winsB++;
    rounds.push({ lane, attacker: a.asset, defender: b.asset, elementEdge: round2(edge - 1), luckA: round4(luckA), luckB: round4(luckB), effA: Math.round(effA), effB: Math.round(effB), winner });
  }
  return { rounds, winner: winsA > winsB ? 'A' : 'B', winsA, winsB, powerA: onChainSquadPower(squadA), powerB: onChainSquadPower(squadB), synergyA: round2(synergyA), synergyB: round2(synergyB) };
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(0.999_999_999, Math.max(0, x)) : 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Bot squad for the 45 s fill: three chips of the rarity whose base power is closest to a third of
 * `targetPower`, levelled so the on-chain squad power lands near the target (bots never pay out
 * more than the participation reward, so a few % of drift is irrelevant). `pick(i)` ∈ [0, 1) comes
 * from the match seed so the bot is reproducible too.
 */
export function botSquad(targetPower: number, pick: (i: number) => number, tag = 'bot'): FighterChip[] {
  const per = Math.max(profile(0).basePower, targetPower / 3);
  let rarity: RarityIndex = 0;
  for (let r = 1; r < 9; r++) if (Math.abs(profile(r as RarityIndex).basePower - per) < Math.abs(profile(rarity).basePower - per)) rarity = r as RarityIndex;
  const out: FighterChip[] = [];
  for (let i = 0; i < 3; i++) {
    const jitter = pick(i) < 0.25 && rarity > 0 ? -1 : pick(i) > 0.85 && rarity < 8 ? 1 : 0;
    const r = (rarity + jitter) as RarityIndex;
    const bp = profile(r).basePower;
    const level = Math.max(1, Math.min(profile(r).maxLevel, Math.round((per / bp - 1) / 0.025) + 1));
    out.push({ asset: `${tag}-${i}`, collection: Math.floor(pick(i + 3) * 10) % 10, rarity: r, level });
  }
  return out;
}
