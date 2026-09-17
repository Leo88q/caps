// =============================================================================
// The legal layer for a product that sells randomised packs (docs/09 §5.2, PRD §7 risk row).
// -----------------------------------------------------------------------------
// Two rules about this file, because both are the kind of thing that gets "cleaned up" later:
//
//  1. `reviewed: false` is not a TODO to tick off, and neither is the copy below. It is a factual
//     statement about the product: the lootbox/gambling question (BE/NL/UK) needs a lawyer, not a
//     translation. The page renders the banner while it is false, so what a player reads matches what
//     the team actually knows. Flipping it belongs to the owner's checklist (docs/09 §7), never to a
//     drive-by commit.
//  2. The numbers are not marketing prose. Fees, caps, windows and burn shares here are the values
//     `packages/economy` and the programs enforce, and `legal.test.ts` compares them against those
//     sources — a ToS that says 7.5 % while the contract charges 10 % is a consumer-protection
//     finding, not a typo.
//
// The English text is canonical. Translations of the UI chrome live in the i18n bundles; the document
// bodies deliberately do not: 7 copies of 2 KB of legalese drift on the first amendment, and a stale
// translation of a terms change is worse than an untranslated one.
// =============================================================================
import { FEES, PACKS } from '@guttercaps/economy';

export type LegalDocId = 'terms' | 'privacy';

export interface LegalSection { h: string; p: string[] }
export interface LegalDoc { slug: LegalDocId; title: string; intro: string; sections: LegalSection[] }

/** ISO-3166 alpha-2 codes the shop refuses to sell packs into (mirrors GEO_DEFAULT_COUNTRIES backend-side). */
export const RESTRICTED_REGIONS = ['BE', 'NL'] as const;
export const AGE_MIN = 18;

export const LEGAL_PATHS: Record<LegalDocId, string> = {
  terms: '/legal/terms',
  privacy: '/legal/privacy',
};

/** Absolute URLs, for places that cannot resolve a relative one (the store listing, the landing page). */
export function canonicalLegalUrl(origin: string, doc: LegalDocId): string {
  return `${origin.replace(/\/+$/, '')}${LEGAL_PATHS[doc]}`;
}

const TERMS: LegalDoc = {
  slug: 'terms',
  title: 'Terms of Service',
  intro:
    'These terms describe what GUTTERCAPS is, what it charges, and what it does not do. They are written ' +
    'against the on-chain programs (chip_core, market, staking, arena): where this text and a program ' +
    'disagree, the program is what actually happens to your transaction.',
  sections: [
    {
      h: '1. What this is',
      p: [
        'A browser game on Solana. You buy packs of collectible chips; the chip you get is drawn at random ' +
        'from a published distribution. Chips live in your wallet as Metaplex Core assets — we never hold them ' +
        'for you, and there is no deposit, withdrawal or custody service in the product.',
        'Packs are a paid randomised item. We do not claim otherwise, we do not call it a purchase of ' +
        'guaranteed value, and the region restrictions in §2 exist because several regulators treat this ' +
        'mechanic as gambling.',
      ],
    },
    {
      h: '2. Who may play, and where packs are not sold',
      p: [
        `You must be at least ${AGE_MIN} years old and old enough to enter into a contract where you live. The app asks you to confirm this once, before the first purchase.`,
        `Randomised packs are not sold to accounts whose region is detected as ${RESTRICTED_REGIONS.join(' or ')}. The refusal happens at the quote the purchase is built from, server-side (POST /v1/packs/quote answers 403 geo_blocked) — not by hiding a button. Everything else in the product remains available in those regions: collection, market, staking and arena.`,
        'Region is read from the country code your network traffic presents at the edge. If you use a VPN, you are making the detection wrong on purpose, which is a breach of these terms and, in the regions named above, a decision about your own legal exposure.',
      ],
    },
    {
      h: '3. Odds, pity and verifiable randomness',
      p: [
        `Every pack's rarity distribution, floor guarantee and pity counter is published in the shop UI and defined in code (packages/economy PACKS; ${Object.values(PACKS).map((p) => `${p.name}: ${p.chips} caps`).join('; ')}). The on-chain program enforces the same table, including the hard caps on the top two tiers.`,
        'Draws use a commit–reveal randomness beacon (Switchboard on-demand). The commitment and the reveal are both on-chain, so a past result can be re-derived: the verify screen takes an open transaction and replays the expansion the program performed. An unresponsive oracle never burns your payment silently — see §5.',
        'Pity counters are per wallet, per SKU and stored on-chain. They are not a promise about a specific draw; they bound the worst run.',
      ],
    },
    {
      h: '4. Price, fees and what is burned',
      p: [
        'Packs cost fiat-equivalent value paid in SOL, USDC, $CG or SKR. Prices are set by the operator and change with the game config; the quote you signed is the price you pay.',
        `Marketplace listings charge a protocol fee of ${FEES.marketplaceFeeBps / 100} % (on-chain hard cap 10 %) plus a listing fee of ${FEES.listingFeeCgMicro / 1_000_000} $CG, and ${Math.round(FEES.marketplaceFeeBuybackShareBps / 100)} % of that fee is routed to buyback-and-burn rather than to us.`,
        `Arena wagers take a ${FEES.pvpRakeBps / 100} % rake of the pot; ${Math.round(FEES.pvpRakePoolShareBps / 100)} % of the rake funds the season prize pool and the rest is burned.`,
        `Packs paid in $CG burn ${FEES.cgPackBurnBps / 100} % of the price. Packs paid in SKR get a ${FEES.skrPackDiscountBps / 100} % discount.`,
        'Network fees (Solana transaction fees, rent for the accounts a pack opens) are yours, not ours. Rent reserved while a pack is in flight is returned when it closes.',
      ],
    },
    {
      h: '5. Refunds, stuck packs and cancellations',
      p: [
        'Opened packs are not refundable: the item was delivered and the draw is irreversible by design.',
        'If the randomness reveal never lands, the pack stays unopened and a full refund from the vault unlocks after the program\'s stale window — one hour, and about 72 minutes in practice once the crank has noticed. You do not have to ask for it; you do have to sign the cancellation.',
        'If we cancel a drop (a defective config, a compromised key, a regulator asking us to stop), every unpaid-for pack in that drop is refunded from the vault on the same path. Refunds are paid back in the currency the purchase used.',
        'Nothing in these terms is a promise that a refund path exists for buyer\'s remorse, and there is no chargeback mechanism: payments are transactions you signed.',
      ],
    },
    {
      h: '6. Fair play, devices and what we may pause',
      p: [
        'Rewards for quests, PvP and seasons are limited per device (three wallets; a fourth on the same device keeps playing but earns no rewards) and are checked against win-trading, wash-trade and bot signals. A signal we can verify gets resolved by an operator, and every operator action on your account is written to an audit log we are willing to show you.',
        'The operator can pause new purchases, listings, stakes and battles for an incident. Unstaking, cancelling, refunding and withdrawing keep working while paused — a pause is never used to freeze your assets.',
        'Abuse of the pity system, the oracle, or a bug in this software to extract value is a breach of these terms; we may reverse the affected transactions in-game and, for on-chain value, only through the programs\' own mechanisms.',
      ],
    },
    {
      h: '7. Your side of the machine',
      p: [
        'You are responsible for your wallet, its seed phrase, and every transaction you sign. We never ask for a seed phrase, never send a "claim" link that needs one, and cannot undo a signature.',
        'You need a Solana wallet that lets you inspect the instruction you are approving. If a signature request shows an unfamiliar program or an unexpected amount, do not sign it.',
      ],
    },
    {
      h: '8. No financial advice, no investment, no guarantee',
      p: [
        '$CG is the in-game currency; it is not offered for sale by us in any public sale, and nothing in the product is an offer of securities, a profit-sharing arrangement, or an investment. Any price you can see for it is set by other people trading it.',
        'The software is provided as-is, without warranty of any kind, to the maximum extent the law where you live allows. Where a liability cap is not allowed, it does not apply to you.',
        'Our aggregate liability for a purchase is capped at the amount you paid for the affected pack(s). This does not limit rights that cannot be limited, including consumer rights that apply despite this clause and any warranty we are required to give.',
      ],
    },
    {
      h: '9. Changes, and which text wins',
      p: [
        'Game parameters (prices, odds tables, fees, pity) change with the on-chain config; the fee values above are the ones in force when this version of the terms was written, and the on-chain hard caps constrain them. We do not treat a parameter change as a change to these terms.',
        'Changes to these terms get a new `effective` date on this page and a note in the changelog. Continued play after that date is acceptance; if you do not accept, stop and take what is yours out (unstake, cancel, withdraw).',
        'These terms are written in English. Other languages are convenience copies; if a translation and the English text disagree about what you owe or what you get, the English text is the one that applies.',
      ],
    },
  ],
};

const PRIVACY: LegalDoc = {
  slug: 'privacy',
  title: 'Privacy',
  intro:
    'There is no account form in this product, so the honest summary is short: we store a wallet address and ' +
    'what that address did in our game. The parts worth reading anyway are §3 (what is on a public ledger ' +
    'cannot be deleted) and §6 (what third parties see).',
  sections: [
    {
      h: '1. What we collect',
      p: [
        'Your Solana address, from the signature you provide when you sign in. A session cookie (name `gc_session`, HttpOnly, SameSite=None over https, 7 days) so the app can show you your own state.',
        'Game records tied to that address: purchases, pack opens and their drawn rarities, listings and offers, staking positions, arena matches, quest claims, referral links, the daily caps and pity counters, and — for operators only — the audit log of actions taken on your account.',
        'Anti-fraud signals: a salted hash of a device fingerprint (used to enforce the per-device wallet limit and deduplicate farming) and a "proof of human" flag from Cloudflare Turnstile. We do not collect a raw fingerprint, and we do not collect the battery, fonts, canvas or sensor data that a fingerprint is often built from.',
        'Rate limiting uses your IP address inside a short window (60 seconds, per IP and per session). The counter is what we keep, not the address.',
      ],
    },
    {
      h: '2. What we never collect',
      p: [
        'No name, email address, phone number, physical address, date of birth, document, selfie or KYC record. We could not identify you from our database alone, and we do not want to be able to.',
        'No payment card data — payments are transactions you sign in your wallet.',
        'No advertising or analytics SDKs, no session replay, no pixel. If that changes, this page changes first.',
      ],
    },
    {
      h: '3. The part a deletion request cannot fix',
      p: [
        'Anything the game writes to Solana is public, permanent and readable by anyone: your address, which packs you opened, which chips you own and traded, your staking and arena history. That is not our database and not our server — it is the chain, and no request to us can remove it.',
        'Our read-model (the app\'s database) is derived from those chain events plus your session data, so deleting it does not delete the underlying history. If you ask us to forget you, what we can actually do is drop the rows we own and refuse to re-link them; the chain keeps its copy.',
      ],
    },
    {
      h: '4. Cookies and local storage',
      p: [
        'One cookie: the session. Everything else is in your browser\'s localStorage under `gc.*` keys (language, theme, motion preference, the age confirmation, queued signatures). Clearing site data removes all of it and the app behaves as a first visit.',
      ],
    },
    {
      h: '5. Legal basis and retention',
      p: [
        'We keep game records for as long as the product runs, because they are the state of the game (ownership, pity, caps) and because our own refund and dispute handling depends on them. Anti-fraud signals are kept to resolve open findings; sessions expire on their own.',
        'Where the GDPR applies, the bases are performance of the contract you signed up to play under, our legitimate interest in not being farmed, and your consent for the two optional things (Turnstile challenge, telemetry to Sentry if the operator enables error reporting).',
      ],
    },
    {
      h: '6. Who else sees it',
      p: [
        'Cloudflare (CDN/WAF, Turnstile challenge, the country code used by the region gate) — it sees request metadata. We read its country header and do not store a client IP ourselves.',
        'A Solana RPC provider (Helius/Triton/QuickNode or self-hosted) relays our reads and your transactions; the payload is public chain data by definition.',
        'Our price pusher talks to Pyth and Hermes for SOL/USD and SKR/USD, and the Switchboard on-demand queue is a public program you can inspect. Neither sees anything about you beyond the transaction.',
        'If error reporting (Sentry) is enabled, an unhandled crash sends a stack trace and the request id; wallets are truncated in that path and the rule is documented in the code, not trusted to luck.',
      ],
    },
    {
      h: '7. Your rights, and how to reach us',
      p: [
        'Access, rectification, erasure, objection, portability, and complaint to your supervisory authority — including the request "delete what is in your database". Where a right collides with the chain (see §3), we will tell you which part we can and cannot do rather than pretend.',
        'The operator contact for privacy requests is published on the same page as the app\'s support address; there is no automated process, because there is no account to authenticate — we ask you to sign a message from the address in question instead.',
        'Minors: the product is for adults (18+). If we learn a child\'s wallet was used against that rule, we delete the rows we own and stop the referral accruals tied to it.',
      ],
    },
  ],
};

export const LEGAL_DOCS: Record<LegalDocId, LegalDoc> = { terms: TERMS, privacy: PRIVACY };
export const LEGAL_IDS: LegalDocId[] = ['terms', 'privacy'];
/** Effective date of the text above — the page shows it, and the store listing quotes it. */
export const LEGAL_EFFECTIVE = '2026-09-17';
/** Counsel sign-off. While false the page says so out loud (see the file header). */
export const LEGAL_REVIEWED = false;

export function legalDoc(id: string | undefined): LegalDoc | undefined {
  return id === 'terms' || id === 'privacy' ? LEGAL_DOCS[id] : undefined;
}

// ---------------------------------------------------------------- age gate
// One localStorage bit, deliberately *not* a server-side claim: the confirmation is an attestation the
// player makes, and storing it on the server would turn a "don't lie to us" gate into a personal-data
// record we would then have to defend in the privacy page above.
const AGE_KEY = 'gc.legal.ageOk';

function store(): Storage | undefined {
  try {
    const s = globalThis.localStorage;
    void s.getItem('__probe__');
    return s;
  } catch { return undefined; }   // SSR, private mode, or a test without DOM
}

export function ageAcknowledged(): boolean {
  const s = store();
  if (!s) return false;
  const v = s.getItem(AGE_KEY);
  // A bare "1" is not enough: the acknowledgement is versioned so a change to the wording re-asks.
  return v === `${AGE_MIN}:${LEGAL_EFFECTIVE}`;
}

export function acknowledgeAge(): void {
  try { store()?.setItem(AGE_KEY, `${AGE_MIN}:${LEGAL_EFFECTIVE}`); } catch { /* a full/blocked quota is not a crash */ }
}

/** For tests and for a "reset my answers" affordance. */
export function forgetAge(): void {
  try { store()?.removeItem(AGE_KEY); } catch { /* nothing to clean */ }
}
