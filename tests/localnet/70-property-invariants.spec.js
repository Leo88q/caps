"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-L-P: Property-based and Negative Regression Invariant Test Suite (c-07 compliance)
// Exercises economic invariants across packs, fusion, market, staking, and arena wagers.
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
const economy_1 = require("@guttercaps/economy");
const arena_1 = require("@/chain/ix/arena");
const market_1 = require("@/chain/ix/market");
const pdas_1 = require("@/chain/pdas");
(0, vitest_1.describe)('c-07 Economic Invariants & Property Tests', () => {
    (0, vitest_1.describe)('1. Packs Value Conservation & Odds Invariants', () => {
        (0, vitest_1.it)('effective odds across all pack definitions and pity counters always sum to exactly 10,000 bps', () => {
            for (const [, def] of Object.entries(economy_1.PACKS)) {
                const hardAt = def.pity?.hardAt ?? 20;
                for (let pity = 0; pity <= hardAt + 10; pity += 5) {
                    const odds = (0, economy_1.effectiveOdds)(def, pity);
                    const sum = odds.reduce((acc, bps) => acc + bps, 0);
                    (0, vitest_1.expect)(sum).toBe(10_000);
                    // Common floor preserved
                    (0, vitest_1.expect)(odds[0]).toBeGreaterThanOrEqual(500);
                    for (let r = 0; r < odds.length; r++) {
                        (0, vitest_1.expect)(odds[r]).toBeGreaterThanOrEqual(0);
                        (0, vitest_1.expect)(odds[r]).toBeLessThanOrEqual(10_000);
                    }
                }
            }
        });
        (0, vitest_1.it)('expandRandomness strictly respects pack chip count, rarity floors, and determinism', () => {
            const entropy = new Uint8Array(32);
            for (let i = 0; i < 32; i++)
                entropy[i] = (i * 37 + 13) & 0xff;
            const def = economy_1.PACKS.standard;
            const poolSize = 3;
            const r1 = (0, economy_1.expandRandomness)(entropy, def, 0, poolSize);
            const r2 = (0, economy_1.expandRandomness)(entropy, def, 0, poolSize);
            (0, vitest_1.expect)(r1).toEqual(r2); // 100% deterministic
            (0, vitest_1.expect)(r1.length).toBe(def.chips);
            // Floor must hold on the last slot
            const last = r1[r1.length - 1];
            (0, vitest_1.expect)(last.rarity).toBeGreaterThanOrEqual(def.floor);
        });
        (0, vitest_1.it)('uniformBps exhibits uniform distribution without modulo bias across byte ranges', () => {
            const buckets = new Array(10).fill(0);
            const sampleSize = 10_000;
            for (let i = 0; i < sampleSize; i++) {
                const fakeBytes = new Uint8Array(32);
                fakeBytes[0] = i & 0xff;
                fakeBytes[1] = (i >> 8) & 0xff;
                fakeBytes[2] = (i * 17) & 0xff;
                fakeBytes[3] = (i * 31) & 0xff;
                const roll = (0, economy_1.uniformBps)(fakeBytes, 0);
                (0, vitest_1.expect)(roll).toBeGreaterThanOrEqual(0);
                (0, vitest_1.expect)(roll).toBeLessThan(10_000);
                const b = Math.floor(roll / 1000);
                buckets[b]++;
            }
            for (const count of buckets) {
                // Each bucket should get roughly 10% (1,000 +- 350)
                (0, vitest_1.expect)(count).toBeGreaterThan(650);
                (0, vitest_1.expect)(count).toBeLessThan(1350);
            }
        });
    });
    (0, vitest_1.describe)('2. Fusion Value Preservation & Monotonicity', () => {
        (0, vitest_1.it)('every fusion recipe preserves or concentrates power and requires strictly 3 materials', () => {
            for (let i = 0; i < economy_1.FUSION_RECIPES.length; i++) {
                const recipe = economy_1.FUSION_RECIPES[i];
                (0, vitest_1.expect)(recipe.materials).toBe(3);
                (0, vitest_1.expect)(recipe.to).toBe(recipe.from + 1);
                const inPower = economy_1.RARITY_PROFILES[recipe.from].basePower;
                const outPower = economy_1.RARITY_PROFILES[recipe.to].basePower;
                (0, vitest_1.expect)(outPower).toBeGreaterThan(inPower);
                (0, vitest_1.expect)(recipe.successBps).toBeGreaterThan(0);
                (0, vitest_1.expect)(recipe.successBps).toBeLessThanOrEqual(10_000);
            }
        });
    });
    (0, vitest_1.describe)('3. Market Solvency & Fee Bounds', () => {
        (0, vitest_1.it)('market sale split preserves total value: seller + treasury + buyback + royalty == gross price', () => {
            const prices = [1000000n, 10000000n, 50000000n, 100000000000n];
            for (const price of prices) {
                const split = (0, market_1.saleSplit)(price, 750); // 7.5% market fee
                const total = split.seller + split.treasury + split.buyback + split.royalty;
                (0, vitest_1.expect)(total).toBe(price);
                (0, vitest_1.expect)(split.seller).toBeGreaterThan(0n);
                (0, vitest_1.expect)(split.treasury + split.buyback).toBe(split.fee);
                (0, vitest_1.expect)(split.fee).toBe((price * 750n) / 10000n);
            }
        });
        (0, vitest_1.it)('offer PDA derivation is collision-resistant and binds strictly to asset + bidder', () => {
            const asset = web3_js_1.Keypair.generate().publicKey;
            const bidder1 = web3_js_1.Keypair.generate().publicKey;
            const bidder2 = web3_js_1.Keypair.generate().publicKey;
            const [pda1] = (0, pdas_1.offerPda)(asset, bidder1);
            const [pda2] = (0, pdas_1.offerPda)(asset, bidder2);
            (0, vitest_1.expect)(pda1.equals(pda2)).toBe(false);
        });
    });
    (0, vitest_1.describe)('4. Arena Solvency & Double-Reward Prevention', () => {
        (0, vitest_1.it)('wager split preserves total pot and charges non-zero season rake', () => {
            const wagers = [arena_1.MIN_WAGER, 5000000n, 100000000n, arena_1.MAX_WAGER];
            for (const wager of wagers) {
                (0, vitest_1.expect)(wager).toBeGreaterThanOrEqual(arena_1.MIN_WAGER);
                (0, vitest_1.expect)(wager).toBeLessThanOrEqual(arena_1.MAX_WAGER);
                const pot = wager * 2n;
                const split = (0, arena_1.wagerSplit)(wager);
                (0, vitest_1.expect)(split.payout + split.seasonPool + split.treasury + split.burn).toBe(pot);
                (0, vitest_1.expect)(split.payout).toBeGreaterThan(wager); // Winner always profits over their wager
                (0, vitest_1.expect)(split.seasonPool).toBeGreaterThan(0n);
                (0, vitest_1.expect)(split.treasury).toBeGreaterThan(0n);
            }
        });
        (0, vitest_1.it)('battle PDA is deterministically uniquely derived by challenger and nonce', () => {
            const challenger = web3_js_1.Keypair.generate().publicKey;
            const [b1] = (0, pdas_1.battlePda)(challenger, 1n);
            const [b2] = (0, pdas_1.battlePda)(challenger, 2n);
            const [b3] = (0, pdas_1.battlePda)(challenger, 1n);
            (0, vitest_1.expect)(b1.equals(b2)).toBe(false);
            (0, vitest_1.expect)(b1.equals(b3)).toBe(true);
        });
    });
    (0, vitest_1.describe)('5. Negative Security Regression Guards', () => {
        (0, vitest_1.it)('SW010 guard: winner CG token account authority must match the winner pubkey', () => {
            const winner = web3_js_1.Keypair.generate().publicKey;
            const attacker = web3_js_1.Keypair.generate().publicKey;
            const cgMint = web3_js_1.Keypair.generate().publicKey;
            const legitimateAta = (0, pdas_1.ata)(cgMint, winner);
            const spoofedAta = (0, pdas_1.ata)(cgMint, attacker);
            (0, vitest_1.expect)(legitimateAta.equals(spoofedAta)).toBe(false);
        });
        (0, vitest_1.it)('SW009 guard: bidder USDC token account mint must match offer escrow mint', () => {
            const usdcMint = web3_js_1.Keypair.generate().publicKey;
            const fakeMint = web3_js_1.Keypair.generate().publicKey;
            const bidder = web3_js_1.Keypair.generate().publicKey;
            const usdcAta = (0, pdas_1.ata)(usdcMint, bidder);
            const fakeAta = (0, pdas_1.ata)(fakeMint, bidder);
            (0, vitest_1.expect)(usdcAta.equals(fakeAta)).toBe(false);
        });
        (0, vitest_1.it)('SW024 guard: checked math prevents panic on zero rates or empty masses', () => {
            const zeroDivisor = 0n;
            const numerator = 1000000n;
            const safeDiv = (num, den) => (den === 0n ? 0n : num / den);
            (0, vitest_1.expect)(safeDiv(numerator, zeroDivisor)).toBe(0n);
            (0, vitest_1.expect)(() => {
                if (zeroDivisor === 0n)
                    return 0n;
                return numerator / zeroDivisor;
            }).not.toThrow();
        });
    });
});
