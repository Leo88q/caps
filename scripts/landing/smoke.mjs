// DOM smoke test for the built landing: runs the inline script in happy-dom,
// checks rendering in EN and RU, ld+json validity and i18n coverage.
//   node scripts/landing/smoke.mjs
import { Browser, BrowserErrorCaptureEnum } from 'happy-dom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(root, 'guttercaps-landing.html'), 'utf8');
const browser = new Browser({ settings: {
  enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableComputedStyleRendering: true,
  errorCapture: BrowserErrorCaptureEnum.tryAndCatch, suppressInsecureJavaScriptEnvironmentWarning: true, fetch: { disableSameOriginPolicy: true },
} });
const page = browser.newPage();
const errors = [];
page.mainFrame.window.fetch = () => Promise.reject(new Error('offline'));
page.mainFrame.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
page.url = 'https://guttercaps.gg/';
page.content = html;
await page.waitUntilComplete();
for (const line of page.virtualConsolePrinter.readAsString().split('\n')) {
  if (/error/i.test(line) && !/external stylesheet/.test(line)) errors.push(line.slice(0, 200));
}
const document = page.mainFrame.document;
const q = (s) => document.querySelector(s), qa = (s) => [...document.querySelectorAll(s)];
const text = (s) => q(s)?.textContent?.trim();
let failed = 0;
const expect = (cond, msg) => { if (!cond) { failed++; console.log('  FAIL', msg); } };

function report(label, lang) {
  console.log(`--- ${label}: html.lang=${document.documentElement.lang} title="${document.title.slice(0, 60)}"`);
  expect(document.documentElement.lang === lang, 'html.lang');
  console.log(' hero:', text('.hero-sub')?.slice(0, 70));
  const steps = qa('#howto .step').length, packs = qa('#packs-grid .pack').length;
  console.log(' steps:', steps, '| packs:', packs, '| pack names:', qa('.pack-name').map((e) => e.textContent).join('/'));
  expect(steps === 5 && packs === 4, 'howto/packs rendered');
  const meter = qa('#meterRows .meter-row').length, permits = qa('#permitGrid .permit').length, districts = qa('#districts .district').length, chips = qa('#districts .chip-slot').length;
  console.log(' meter rows:', meter, '| permits:', permits, '| districts:', districts, '| chips:', chips);
  expect(meter === 9 && permits === 9 && districts === 10 && chips === 90, '9 tiers / 10 districts / 90 chips');
  console.log(' faq:', qa('#faq details').length, '| first q:', text('#faq summary'));
  console.log(' stats status:', text('#stats-status')?.slice(0, 60), '| nums:', qa('[data-stat]').map((e) => e.textContent).join(','));
  console.log(' disabled links:', qa('a[aria-disabled="true"]').length, '| app hrefs:', [...new Set(qa('[data-link="app"]').map((a) => a.getAttribute('href')))].join(','));
  const clone = document.body.cloneNode(true); clone.querySelectorAll('script').forEach((n) => n.remove());
  const bodyText = clone.textContent;
  const bad = (bodyText.match(/undefined|\[object|NaN/g) || []).length;
  console.log(' bad literals in DOM text:', bad);
  expect(bad === 0, 'no undefined/[object/NaN in DOM');
}
report('EN (default)', 'en');
qa('.lang-toggle button').find((b) => b.dataset.lang === 'ru').click();
await page.waitUntilComplete();
report('RU', 'ru');
console.log(' RU sample mech:', text('.mech-card h3'), '|', text('.mech-card p')?.slice(0, 50));
console.log(' RU nav:', qa('.nav-links a').map((a) => a.textContent).join(' · '));
console.log(' RU pressed:', qa('.lang-toggle button').map((b) => b.dataset.lang + '=' + b.getAttribute('aria-pressed')).join(' '));
expect(/Фьюжн/.test(text('.mech-card h3')), 'RU mechanics translated');
expect(/Мир/.test(text('.nav-links a')), 'RU nav translated');
qa('.lang-toggle button').find((b) => b.dataset.lang === 'en').click();
await page.waitUntilComplete();
report('EN again', 'en');
expect(text('.mech-card h3') === 'Fusion 3 → 1', 'EN restored after round-trip');
for (const s of qa('script[type="application/ld+json"]')) { const j = JSON.parse(s.textContent); console.log(' ld+json:', j['@type'], j.mainEntity ? j.mainEntity.length + ' Q' : j.name); }
const ruStart = html.indexOf('const RU = ') + 11; const RU = JSON.parse(html.slice(ruStart, html.indexOf(';\n', ruStart)));
const keys = qa('[data-i18n],[data-i18n-html]').map((e) => e.dataset.i18n || e.dataset.i18nHtml);
const missing = [...new Set(keys)].filter((k) => !(k in RU));
console.log(' i18n keys in DOM:', new Set(keys).size, '| missing RU:', missing);
expect(missing.length === 0, 'RU coverage');
console.log('script errors:', errors);
expect(errors.length === 0, 'no script errors');
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
