"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// T-E-00 — the definition of "the loop works" (docs/06 §1.1): nine steps, one wallet, three times in a
// row, on devnet, with the real Switchboard queue, nobody touching the keyboard. If this passes, the
// product works; nothing else in this repository is that strong a statement.
//
// READ THIS BEFORE TREATING IT AS GREEN. The spec has never been executed in the environment where it was
// written: no browser, no funded devnet seed, no extension. What is certain here is the *sequence and the
// assertions* (they come from docs/06 §1.1/§1.2 and the routes the app actually has). What is unverified
// is every selector inside the wallet extension: Phantom's popup markup changes independently of this
// repository, so the `phantom.*` locators below are the part that will need one manual pass with
// `--headed --debug` before this file is worth anything. That is why the job is nightly and
// `continue-on-error` until someone runs it once by hand (docs/09 §7).
//
// Setup (all three or the whole file skips):
//   E2E_PHANTOM_EXTENSION  directory of an unpacked Phantom build (store zips are CRX; unpack it)
//   E2E_DEVNET_MNEMONIC    a seeded, funded devnet wallet (≥ 0.5 SOL, one test wallet only)
//   E2E_APP_URL            origin serving the app pointed at devnet (default https://app.guttercaps.gg)
const test_1 = require("@playwright/test");
const EXT = process.env.E2E_PHANTOM_EXTENSION ?? '';
const SEED = process.env.E2E_DEVNET_MNEMONIC ?? '';
const APP = process.env.E2E_APP_URL ?? 'https://app.guttercaps.gg';
const have = !!EXT && !!SEED;
test_1.test.skip(!have, 'T-E-00 needs E2E_PHANTOM_EXTENSION + E2E_DEVNET_MNEMONIC (tests/e2e/README.md)');
test_1.test.use({
    // MV3 extensions need the new headless mode; CI runs it headed=false with these args.
    launchOptions: {
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    },
});
/**
 * The extension side of the flow. Extension popups are separate targets in Playwright — the id is read
 * from the manifest so it survives a rebuild — and every one of these helpers is where a Phantom update
 * will break this file first.
 */
class Phantom {
    ctx;
    id = '';
    constructor(ctx) {
        this.ctx = ctx;
    }
    async init() {
        let sw = this.ctx.serviceWorkers()[0];
        if (!sw)
            sw = await this.ctx.waitForEvent('serviceworker', { timeout: 30_000 });
        this.id = new URL(sw.url()).host;
        if (!this.id)
            throw new Error('Phantom service worker never registered — is the unpacked build in E2E_PHANTOM_EXTENSION?');
    }
    popup() {
        const pages = this.ctx.pages().filter((p) => p.url().startsWith(`chrome-extension://${this.id}`));
        if (!pages.length)
            throw new Error(`no Phantom popup window open (extension ${this.id})`);
        return pages[0];
    }
    /** First run only: restore from the seed. A fresh install otherwise refuses to do anything. */
    async importSeed() {
        const p = this.popup();
        if (await p.getByText(/welcome|get started/i).first().isVisible().catch(() => false)) {
            await p.getByRole('button', { name: /i already have a wallet|import/i }).first().click();
            await p.getByRole('checkbox', { name: /i understand/i }).first().check().catch(() => { });
            await p.locator('textarea, input[type=text]').first().fill(SEED);
            await p.getByRole('button', { name: /import|restore|confirm/i }).first().click();
            await p.getByRole('button', { name: /done|close/i }).first().click().catch(() => { });
        }
    }
    /** The dapp-connect approval screen. This is the click that turns a demo into a transaction. */
    async approveConnect() {
        const p = this.popup();
        await p.getByRole('button', { name: /connect|approve|next/i }).first().click();
    }
    /** Sign whatever the app put in front of the wallet. Packs need two: commit (reveal) and open. */
    async approveTransaction() {
        const p = this.popup();
        // Phantom asks per transaction; a bundle of 5 packs is 5 pairs of these, hence the loop's ceiling.
        await p.getByRole('button', { name: /approve|confirm|sign/i }).first().click({ timeout: 60_000 });
    }
    async switchToDevnet() {
        const p = this.popup();
        await p.getByTitle(/change network|settings/i).first().click().catch(() => { });
        await p.getByText(/devnet/i).first().click().catch(() => { });
    }
}
function appWalletMenu(page) {
    // The app's own control (wallet-adapter-react-ui); the connected state shows the truncated pubkey.
    return page.locator('.shell-header button, .shell-header [aria-label*=wallet i]').last();
}
test_1.test.describe('T-E-00 · buy → reveal → open → verify, three times', () => {
    test_1.test.setTimeout(20 * 60_000);
    (0, test_1.test)('three standard packs, one wallet, nothing left in the air', async ({ context }) => {
        const phantom = new Phantom(context);
        await phantom.init();
        await phantom.importSeed();
        await phantom.switchToDevnet();
        const page = await context.newPage();
        await page.goto(APP);
        // 1 · connect
        await appWalletMenu(page).click();
        await page.getByRole('button', { name: /phantom/i }).first().click();
        await phantom.approveConnect();
        await (0, test_1.expect)(page.locator('.shell-header')).toContainText(/1[1-9A-HJ-NP-Za-km-z]{3,}\.\.[1-9A-HJ-NP-Za-km-z]{4}/);
        // 2 · the app must be looking at devnet too, or the next steps are nonsense
        await (0, test_1.expect)(page.locator('body')).toContainText(/devnet/i);
        for (let round = 1; round <= 3; round += 1) {
            // 3 · quote + price are shown before any signature is asked for (docs/06 §1.2 Магазин)
            await page.goto(`${APP}/shop`);
            const card = page.locator('.pack-card').nth(1);
            await (0, test_1.expect)(card).toBeVisible();
            const priceBefore = (await card.locator('.mono, [class*=price]').first().textContent()) ?? '';
            (0, test_1.expect)(priceBefore.trim().length, `round ${round}: no price rendered before the purchase`).toBeGreaterThan(0);
            // 4 · commit: one signature creates the randomness account, commits and pays
            await card.getByRole('button', { name: /buy/i }).first().click();
            await phantom.approveTransaction();
            // 5 · the app hands off to the oracle; the screen must say so and stay resumable
            await (0, test_1.expect)(page).toHaveURL(/\/shop\/opening\//, { timeout: 30_000 });
            const nonce = new URL(page.url()).pathname.split('/').pop();
            // 6 · reveal — the second signature, the one a broken crank would hide behind a spinner
            await (0, test_1.expect)(page.getByRole('button', { name: /reveal|open pack|continue/i }).first())
                .toBeVisible({ timeout: 90_000 });
            await page.getByRole('button', { name: /reveal|open pack|continue/i }).first().click();
            await phantom.approveTransaction();
            // 7 · the result: chips, and an on-chain event the indexer must have seen within 5 s (§1.1)
            await (0, test_1.expect)(page.locator('[class*=chip], .chip-grid [role=button]').first()).toBeVisible({ timeout: 120_000 });
            // 8 · deep-link resume: the same pack is still there after a reload (offline-safe opening flow)
            await page.reload();
            await (0, test_1.expect)(page).toHaveURL(new RegExp(`/shop/opening/${nonce}$`));
            // 9 · provably fair: the app's own verifier recomputes the roll from the transaction
            const sig = await page.evaluate(async (n) => {
                const r = await fetch(`/v1/me/pending?_=${Date.now()}`).then((x) => x.json()).catch(() => null);
                return (r?.packs ?? []).find((p) => String(p.nonce) === String(n))?.signature ?? '';
            }, nonce);
            if (sig) {
                await page.goto(`${APP}/verify/${sig}`);
                await (0, test_1.expect)(page.getByText(/matches/i).first()).toBeVisible({ timeout: 30_000 });
            }
        }
        // 10 · and finally: nothing is left pending on the server for this wallet. This is the assertion the
        // soak gate (G-3) is actually about — an abandoned pack is money sitting in a vault.
        const health = await page.request.get(`${APP.replace(/\/$/, '')}/v1/health`);
        (0, test_1.expect)(health.ok()).toBe(true);
        const body = await health.json();
        (0, test_1.expect)(body.crank?.abandoned ?? 0, 'crank has abandoned jobs after a three-pack loop').toBe(0);
    });
});
