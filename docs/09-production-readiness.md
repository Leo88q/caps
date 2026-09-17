# 09 · Production readiness: аудит «что не доделано до деплоя»

> Проверка состояния репозитория `Leo88q/caps` (HEAD `067fadf`, ветка `arena/01a0afff-caps`) на дату 2026-09-17.
> Метод: всё, что заявлено в `docs/06`/`docs/08` как «сделано», прогонялось локально; то, что заявлено
> как «не собрано», проверялось по исходникам, по CI-API и по индексу crates.io.
> Никаких правок кода этот документ не содержит — это диагноз + план.

## 0. Вердикт

**К продукту готовы клиент, бэкенд и экономическая модель. К деплою — нет.**
Ни один ончейн-артефакт этого проекта ни разу не существовал: нет `Cargo.lock`, нет `target/deploy/*.so`,
нет IDL, нет ни одного зелёного прогона CI в истории, нет задеплоенных программ.
Из 9 шагов приёмочной петли (PRD/`docs/06` §1.1) **6 шагов упираются в G-0 (первая компиляция)**,
3 шага (auth, коллекция/индексатор, арена-off-chain) реально работают и покрыты тестами.

Продуктового «last mile» тоже нет: ToS/Privacy не написаны (0 файлов), art/иконки для dApp Store
отсутствуют, критический путь клиента на **48 % тяжелее** собственного бюджета,
Postgres-слой описан в `prisma/schema.prisma`, но в коде его нет (живёт на `node:sqlite`),
инфраструктурных манифестов (Dockerfile/compose/deploy-workflow/nginx) — ноль.

Реалистичный срок до mainnet: **6–8 недель календаря**, из них 14 дней — обязательный devnet-soak
и 2–4 недели — внешний аудит (параллельно). Инженерного времени: **≈ 25–35 человеко-дней**,
плюс блок «только владелец» (деньги, ключи, юрзаключение, Hermes-ключ, пуш-кошелёк).

### Статус по launch-gates (`docs/06` §1.4)

| Gate | Условие | Статус | Что мешает прямо сейчас |
|---|---|---|---|
| G-0 Compile | `anchor build` + `cargo test` зелёные, IDL, `keys sync` | ⛔ **0 %** | нет тулчейна/сети в среде разработки; 4 подтверждённых риска в `Cargo.toml` (§1) |
| G-1 P0 security | SEC-C1/C2/C3/H1/H2 + T-L-* зелёные | ⛔ блок | всё упирается в G-0; T-D-04 (CPI reveal) не проверялся нигде |
| G-2 Localnet | 77 сценариев зелёные в CI | ⛔ блок | сьют собирается, но **скипается молча** (`exit 0`, 83 skipped) — см. §3.3 |
| G-3 Devnet soak | 14 дней, ≥10 000 паков | ⛔ не начат | нет деплоя, нет devnet-ключа, нет `scripts/load`-ботов |
| G-4 Аудит | отчёт, Critical/High закрыты | ⛔ не начат | `docs/08` собран, но frozen commit/тег не проставлены; **скоуп в `docs/06` занижен в 2.4×** (§6.4) |
| G-5 Ключи/операции | Squads, pauser, runbook, алерты I1–I8 | ⛔ 0 % | мультисиги не созданы, runbook существует только для pyth-pusher, алертов нет |
| G-6 Нагрузка | LT-1..LT-6, таблица CU | ⛔ 0 % | нет ни k6-скриптов, ни замеренных CU (оценки в `docs/06` §4.2 — из воздуха) |
| G-7 Продукт/право | ToS/Privacy, шансы, dApp Store | ⛔ ~40 % | юр-страниц нет, арт/иконки/скриншоты нет, гео-гейт — заглушка (§5) |

## 1. G-0: что именно сломается при первой сборке (проверено по индексу crates.io)

Ончейн-половина написана «вслепую» — это не критика стиля, а источник конкретных, заранее известных
ошибок. Проверено без компилятора: манифесты зависимостей сверены с записями crates.io-индекса.

| # | Находка | Доказательство | Что делать |
|---|---|---|---|
| 1.1 | `pyth-solana-receiver-sdk =1.0.1` **не имеет ни одной cargo-feature** (`features: {}` в индексе, `anchor-lang ^0.31.1` — обязательная зависимость) → у `PriceUpdateV2` нет и не может быть `impl IdlBuild`. `anchor build` в 0.31.x включает `idl-build`, и `Account<'info, PriceUpdateV2>` в `#[derive(Accounts)]` struct с высокой вероятностью даст `E0277: PriceUpdateV2: IdlBuild is not satisfied` | `programs/chip_core/src/instructions/packs.rs:144`, `services.rs:65`; индекс crates.io | заменить на `/// CHECK: UncheckedAccount` + `PriceUpdateV2::try_from_slice(&acc.try_borrow_data()?)` (все проверки owner/feed/age остаются в силе), либо форк-крайт с `idl-build`, либо `anchor build --no-idl` на время G-0 (IDL тогда не сгенерируется — это часть G-0) |
| 1.2 | `mpl-core 0.12.1` + `default-features = false`: фича `anchor` существует (в `features2`: `["dep:anchor-lang-0-31","dep:borsh","dep:solana-program-2","kaigan/anchor"]`) — ок. **Но** выключен `default = ["borsh-v1"]`, а `BaseAssetV1::from_bytes` живёт в borsh1/kaigan-пути → риск «no method `from_bytes`» | `programs/*/Cargo.toml`; `arena/lib.rs:26` и `market/lib.rs:25` импортируют `accounts::BaseAssetV1` | пробовать `features = ["anchor","borsh-v1"]`; если `solana-program ^3` (дефолт mpl-core 0.12) конфликтует с `solana-program ^2` у anchor-lang 0.31 — переходить на `anchor-0-32`-ветку mpl-core или на 0.11.1, где `anchor`-фича была единственной |
| 1.3 | `switchboard-on-demand 0.13.0`, `features=["anchor"]` — валидно (`anchor = ["anchor-lang","solana-v2"]`); дефолт-фичи (`cpi`,`solana-v2`) не отключены, т.е._solana-program v2 — согласуется с anchor 0.31. Риск ниже: `accounts::RandomnessAccountData` может быть загейчен другой фичей | `programs/chip_core/src/randomness.rs:36` | если `::accounts` недоступен — `switchboard_on_demand::RandomnessAccountData` в корне; CPI-то и так собраны вручную по дискриминаторам, это правильно (нет зависимости от `cpi`-типов) |
| 1.4 | В репозитории **нет `Cargo.lock`** → транзитивные версии не зафиксированы; verifiable build (`solana-verify`) и повторная сборка аудитором дадут другой граф зависимостей | `ls Cargo.lock` → отсутствует | после первой удачной сборки закоммитить `Cargo.lock` в репозиторий и включать в frozen commit |
| 1.5 | `rust-toolchain.toml` пиннит 1.89.0, но комментарий ссылается на «mpl-core 0.10» (в коде 0.12.1) | `rust-toolchain.toml:1` | актуализировать комментарий/проверить, что 1.89 годится для solana-program 2/3 |
| 1.6 | Ожидаемая работа по исходам `docs/08` §4.1 подтверждается объёмом: 6 552 строки Rust, 25 `#[test]` + `tests/golden.rs`, ни разу не компилировались; спеки местами ожидают коды `2001/2003` там, где будут кастомные `6000+` | `grep -c "#\[test\]"` = 25; `docs/08` §4.2 | заложить 1–3 дня чисто на compile-pass + прогон 77 сценариев с правками ассертов |

**Практический вывод:** G-0 невозможно сделать в этой песочнице (нет `cargo/rustc/anchor/solana`,
`crates.io`/`static.rust-lang.org`/`api.devnet.solana.com` недоступны, доступны только npm/GitHub/PyPI).
Значит G-0 надо делать **в CI** (job `programs` уже настроен под `solanafoundation/anchor:v0.31.1`) —
а CI сейчас не запускается по финансовой причине (§3.1). Это единственная реальная критическая точка всего проекта.

## 2. Program IDs: «placeholder» превращается в задачу миграции

`Anchor.toml` содержит `[programs.localnet]` и `[programs.devnet]` **с одинаковыми id** и **не содержит
`[programs.mainnet]`**; `[provider] cluster = "devnet"`. Все четыре id подписаны как «Placeholder IDs —
run `anchor keys sync` after the first `anchor build`».

Последствия, которые надо закрыть **до** деплоя, а не после:

1. `anchor keys sync` перепишет `declare_id!` на id того keypair'а, который лежит в `~/.config/solana/id.json`
   разработчика. Для прода это неприемлемо: id должен быть выведен из холодного keypair'а, которым
   владеет мультисиг. Правильный порядок: сгенерировать 4 keypair'а → положить id в `Anchor.toml`
   (devnet и mainnet — разные секции!) → *не* запускать `keys sync`, а проверять `solana-keygen pubkey`
   по `target/deploy/<p>-keypair.json`.
2. Смену id надо синхронно сделать в 7 местах: `programs/*/src/lib.rs` (`declare_id!`),
   `programs/chip_core/src/instructions/chip.rs:20–22` (MARKET/STAKING/ARENA), `Anchor.toml`,
   `client/src/app/config.ts` (дефолты), `backend/src/config.ts` (дефолты), `tests/localnet/fixtures`,
   `.github/workflows/ci.yml` (hard-coded id в devnet-smoke), плюс `npm run economy:check` (sync-check
   пиннит id) и `docs/08` §1.2.
3. Один и тот же id в devnet и mainnet — допустимый приём (один keypair, обе сети), но тогда
   **утечка devnet-ключа = компрометация прода**. Либо сознательно принять и хранить keypair в
   Squads/HSM, либо использовать разные id и добавить `[programs.mainnet]`.

## 3. CI/CD: нет ни одного работающего конвейера

### 3.1 CI мёртв по финансовой причине (не из-за кода)
Последние 10 прогонов — все `failure`, длительность 6–9 с. Аннотации GitHub API:
*«The job was not started because recent account payments have failed or your spending limit needs to be
increased»*. Т.е. **в истории проекта нет ни одного зелёного прогона** — ни `economy`, ни `client`,
ни `backend` (локально они проходят: см. §3.4). До G-0: оплатить Actions/поднять self-hosted runner,
иначе «сборка программ» не произойдёт никогда.

### 3.2 Конвейера деплоя нет вообще
В `.github/workflows/` только `ci.yml`. Нет: сборки и публикации образов, деплоя клиента (`dist/`)
и бэкенда, `solana-verify submit` (для сверки on-chain bytecode), миграций БД, rollout/rollback,
управления секретами (нет ни `secrets.` в workflow, ни `.env.example` у бэкенда при **79** env-переменных).

### 3.3 CI врёт «зелёным» там, где тесты не запускались
- job `programs` и job `localnet` помечены `continue-on-error: true` → красная сборка программ не блокирует PR;
- localnet-сьют при отсутствии `.so` **скипает всё и выходит с кодом 0**:
  `tests/localnet/*.spec.ts` → `describe.skipIf(!bins.ok && !process.env.LOCALNET_RPC)`.
  Локально: `Test Files 7 skipped, Tests 83 skipped`, `EXIT=0`.
- `npm run test:validator` (`anchor test`) в CI не запускается вовсе.
Минимальная правка: fail-fast (`throw`) при отсутствии бинарей + отдельный guard `--reporters=json`
с проверкой «выполнено > 0», и снятие `continue-on-error` сразу после первого зелёного `programs`.

### 3.4 Что действительно зелёное (мой прогон 2026-09-17, `npm ci && npm run verify` → exit 0)

| Слой | Результат |
|---|---|
| `economy:check` | инварианты + golden (64 вектора) + sync-check — OK |
| `economy:test` (node:test) | все сабтесты OK |
| `client` | `tsc -p` OK · vitest **104/104** · `vite build` OK |
| `backend` | `tsc -p` OK · vitest **150/150** |
| `landing` | `landing:check` — 56 ✓-проверок + DOM-smoke (EN/RU) без ошибок |
| API-бут | `serve.ts` поднимается на SQLite-in-memory, `/v1/health`, `/v1/packs` отвечают корректно |
| `npm test` (localnet) | ⚠️ 83 skipped (нет бинарей) — формально «успех» |

Числа в документации устарели: `docs/08` говорит «client 91, backend 111», `docs/06` §0 — «client 73, backend 23»,
«77 сценариев» (сейчас 83 теста / 77 `it()`), «17 `#[test]`» (сейчас 25). Мелочь, но аудитор сверяет именно это.

## 4. Бэкенд: готов как сервис, не готов как продакшн

| # | Проблема | Доказательство | Что сделать |
|---|---|---|---|
| 4.1 | **Базы данных в проде нет.** Всё живёт на `node:sqlite` (`DatabaseSync`), а Postgres-слой — только схема Prisma: `@prisma/client` отсутствует в зависимостях бэкенда, `backend/prisma/migrations/` нет | `backend/src/db.ts:1–10`; `grep prisma backend/src/*.ts` → 2 упоминания в комментариях; `backend/README.md:397` «Swap `db.ts` for Postgres» | либо честный вариант «1 инстанс + SQLite + LVM-диск» (задокументировать RPO), либо реализация Postgres-адаптера (34 SQLite-специфичных места: `INSERT OR IGNORE`, `PRAGMA`, `AUTOINCREMENT`, `COLLATE NOCASE`, `strftime`) + `prisma migrate deploy` в CI. Оценка 3–5 дней |
| 4.2 | Rate-limit и nonce-кап — **in-memory** (один процесс). За docs-обещанием «Redis» (§3.1, `docs/03` §3.1) ничего не стоит: >1 реплики = лимиты обходятся, nonce живёт в памяти процесса | `backend/src/ratelimit.ts` (store с интерфейсом под Redis, но без Redis-имплементентации); `grep redis backend/src` → 0 | либо зафиксировать «один инстанс API + sticky», либо Redis-стор (1 день). Для 2 000 rps из целей `docs/06` §1.3 один инстанс Express — не вариант |
| 4.3 | WS-канала нет, хотя клиент на него настроен: `VITE_WS_BASE=/ws`, `client/src/api/ws.ts` слушает события индексатора; на бэкенде нет ни `ws`-зависимости, ни upgrade-хендлера → деградация в polling (скрытая) | `grep -n "'/ws'\|WebSocketServer" backend/src/*.ts` → пусто | либо реализовать `/ws` из `listen`-цикла, либо убрать WS из конфига/доков и пересмотреть цель «фишка видна ≤ 5 с» |
| 4.4 | Нет graceful shutdown у API-процесса → обрезанные запросы при рестарте/деплое | `backend/src/serve.ts` (9 строк, без `SIGTERM`); shutdown есть только в `listen.ts` | `server.close()` + флаг draining + `/healthz`(live) vs `/readyz` |
| 4.5 | 500-ответ отдаёт наружу сообщение внутреннего исключения; security-заголовков нет (ни CSP, ни HSTS, ни X-Content-Type-Options); тело запроса ограничено 16 KB ✓, CSRF ✓, cookie ✓ | `backend/src/server.ts:265–274`; `grep -r helmet\|Strict-Transport\|Content-Security backend/src client/index.html` → пусто | `app.use(helmet(...))` + CSP с `connect-src` на RPC/Turnstile/fonts + фиксированный `internal_error` + correlation-id в логах |
| 4.6 | Наблюдаемости нет: `/v1/health` есть (богато: crank/finality/burn/reward/antifraud/paused ✓), но нет `/metrics`, структурированных логов, error tracking, вершины версий/коммита, алертов по инвариантам I1–I8 | `grep metrics\|prometheus\|sentry` → 0 | Prometheus-текст-экспозер + Loki/Promtail или CloudWatch; 8 алертов из `docs/06` §3.9; `--version` из `git rev-parse` в `/health` |
| 4.7 | Контракт API разъезжается со spec: `/collections/{idx}/chips/{rarity}` задекларирован в `openapi.yaml` (клиентский mock его использует) — **404 вживую**; `/stats` и `/wallet/{address}/events` реализованы, но не описаны. CI-шаг проверяет только актуальность `schema.d.ts`, а не полноту | мой прогон: `curl /v1/collections/0/chips/1` → 404; скрипт-сверка: spec 53 / impl 54 | либо реализовать, либо убрать из spec; добавить в CI step «каждый path из spec имеет маршрут» |
| 4.8 | Антифрод/Turnstile/киперы требуют ключей и внешних сервисов, которых нет: `TURNSTILE_SECRET`, `CRANK_KEYPAIR`, `BURN_ORACLE_KEYPAIR`, `QUEST/SEASON/BATTLE_ORACLE_KEYPAIR`, `PYTH` payer | 79 env-переменных, нет `backend/.env.example` (есть только у client и ops/pyth-pusher) | `backend/.env.example` + `docs/runbook.md` + `docker-compose.yaml` для локального стека (api+listen+crank+3 oracle+pyth-cache+client) |

## 5. Клиент и продукт

| # | Проблема | Доказательный факт | Что сделать |
|---|---|---|---|
| 5.1 | **Перфоманс-бюджет нарушен на 48 %**: цель `docs/06` §1.3 — ≤ 350 KB gzip на критическом пути, фактически **518.2 KB** (index 52.7 + react 86.4 + solana 89.6 + wallet 52.0 + switchboard 228.8 + css 8.7). Правило «Switchboard — только dynamic import» не выполнено: `switchboard` вынесен в `manualChunks` и предзагружается `<link rel=modulepreload>` из `dist/index.html` | мой замер `dist/` после `vite build` | убрать `switchboard` из `manualChunks` (ленивый `import()` внутри `usePackFlow`), проверить 4-й чанк `wallet`; цель ≤ 350 KB. 0.5–1 день |
| 5.2 | Юридический слой не собран: ToS/Privacy нет вообще (в лендинге 10 «выключенных» ссылок `href="#"`), при этом `dapp-store/PORTAL_CHECKLIST.md` требует резолвящиеся URL Privacy/Terms/copyright; age-gate 18+ (PRD §7 «18+») не реализован; **гео-гейт — заглушка**: бэкенд жёстко возвращает `geoRestricted: false`, флаг `VITE_FLAG_GEO_GATE` по умолчанию `false`, а lootbox-регулирование BE/NL — задокументированный риск | `grep geoRestricted backend/src/queries.ts:118`; `ls` по репо — нет terms/privacy; `client/.env.example` | 2 статичные страницы (7 локалей) + ссылка в футере/модалке + реальная гео-проверка (GeoIP на входе в checkout, решение «блок покупки, не блок игры») + юрзаключение до mainnet (владелец) |
| 5.3 | Контент для магазина и кошельков отсутствует: `icon-192.png`, `icon-512.png` (512 — без альфы), `banner.png 1200×600`, ≥4 скриншота 1080p, `og.png` (на который ссылается `client/index.html`). `client/public/` = 3 файла, из них `ICONS_NEEDED.txt`. Арт 90 фишек — процедурный SVG-плейсхолдер, ТЗ художнику готово (`docs/07`) | `ls client/public`; `dapp-store/media/README.txt`; `client/src/shared/ui/ChipArt.tsx:1` | владелец/дизайнер: мастера → пайплайн нарезки → CDN. Это внешний блокер dApp Store-эксклюзива, а не кодерский |
| 5.4 | E2E-контур не начат: `docs/06` §3.7 описывает Playwright (T-E-00..13, включая MWA на Android), в репозитории нет ни `playwright.config`, ни `tests/e2e`. `tsc -p tests/localnet` в CI — единственная проверка типов спеков | `find . -name "*playwright*"` → пусто | 1 день на T-E-00 (петля на devnet одним кошельком 3×) — это и есть определение «готово»; без него G-3 не подписать |
| 5.5 | Нет Lighthouse CI и axe (обе цели §1.3: TTI ≤ 3.5 с, WCAG AA на денежных экранах) | отсутствие конфигов | 1 день на `lhci` + `@axe-core/playwright` в e2e |
| 5.6 | Зависимости клиента тянут устаревший Node-путь: 23 npm-уязвимости в **prod**-дереве (6 high: `bigint-buffer`, `toml`, и транзитивно `@coral-xyz/anchor`, `@solana/spl-token`, `@solana/buffer-layout-utils`, `@switchboard-xyz/on-demand`), dependabot/renovate не настроен, `SECURITY.md` нет, `LICENSE` нет, в git закоммичен `.DS_Store` | `npm audit --omit=dev`; `ls .github` → только `workflows` | `dependabot.yml` (npm + cargo), `npm audit fix`-PR, `LICENSE` (или `UNLICENSED`), `git rm --cached .DS_Store`, `SECURITY.md` с политикой bounty из `docs/08` §6 |

## 6. Ончейн-план, который надо выполнить сразу после G-0

1. **T-D-04 до всего остального** (риск переделки SEC-C3, `docs/08` §4.3): на devnet прогнать
   `randomness_init/commit/reveal/close` с authority = PDA `rng_auth`. Если Switchboard требует подпись
   keypair'а, а не PDA — менять схему на authority-transfer; это единственный пункт, способный
   переписать архитектуру, и он же единственный, который нельзя проверить без сети.
2. Замерить CU (`docs/06` §4.2) и фактическую ренту chip-аккаунтов (T-D-03, `RENT_RESERVE_PER_CHIP = 0.008`
   — оценка ×1.3), и решить #23 (`randomness_close_lut`, ~0.0015 SOL/пак утечки ренты).
3. `npm run economy:check` (sync-check) + правки `tests/localnet` под реальные коды ошибок (ожидаемо
   6000+ вместо `2001/2003`).
4. `solana-verify build --library-name <p>` для 4 программ, `anchor deploy` в devnet, хэши — в `docs/08`.
5. **Пересчитать скоуп аудита**: `docs/06` G-4 заявляет «~2.4 k LOC», `docs/08` §1.2 пофайлово даёт
   chip_core ≈3 190 + market ≈560 + staking ≈1 415 + arena ≈655 ≈ **5 820**, фактические `wc -l` —
   **6 552 строки** Rust. Для ценообразования и SLA аудита это ×2.4; закладывать в договор и в
   2–4 недели календаря.

## 7. План: 4 недели до mainnet-ready (без soak и аудита — они идут параллельно)

| Неделя | Задача | Гейт | Выход |
|---|---|---|---|
| 1 | Оплатить Actions / self-hosted runner (30 мин, но блокирует всё) · compile-pass по §1.1–1.5 · `anchor build` ×4 + `--features localnet` · `cargo test --workspace` · `keys sync` → заморозка id по §2 · включить `localnet` без `continue-on-error` и добавить fail-fast на skip | G-0, G-2 | 4 `.so` + IDL + `Cargo.lock` в репо; 77 сценариев зелёные в CI |
| 1–2 | SEC-C1/C2/C3, H1/H2 — подтверждение тестами T-L-C10..C20, T-L-F06..F08, T-L-A05..A06, T-B-40 · **T-D-04** на devnet · `anchor deploy` + `solana-verify` | G-1 | devnet-контракты + хэши в `docs/08` |
| 2 | Postgres/Prisma-адаптер + миграции в CI (4.1) · Redis-стор лимитов (4.2) · `helmet`/CSP + `internal_error` (4.5) · `/metrics` + 8 алертов инвариантов (4.6) · `backend/.env.example` (4.8) | G-5 (частично) | 1 docker-compose прод-стек, 2 реплики API без потери лимитов |
| 2–3 | Инфраструктура: Dockerfile (client nginx+`/v1` proxy, backend, 5 киперов), deploy-workflow + rollback, `prisma migrate deploy`, секреты в vault/Envs | G-5 | staging-контур с автосбором из main |
| 3 | Клиент: перфоманс (5.1) · юр-страницы + гео/age (5.2) · E2E T-E-00 (5.4) · Lighthouse/axe (5.5) · dependabot/LICENSE (5.6) | G-6, G-7 | критический путь ≤ 350 KB, TTI ≤ 3.5 с, зелёный e2e |
| 3–4 | Нагрузка LT-1..LT-6 (k6) + заполнение CU-таблицы · crank-soak-боты (10 000 паков), `scripts/load/lt*.js` | G-6, старт G-3 | отчёт по нагрузке, 0 «зависших» pending |
| — | Внешний аудит (2–4 нед, параллельно с 3–4) + re-audit диффа | G-4 | отчёт, Critical/High закрыты |

### Блоки, которые код не закроет (владелец)

- GitHub Billing/Actions-лимит (без этого G-0 не произойдёт — §3.1).
- Squads 3/5 + 48 h (chip_core, staking), 2/5 (market, arena), pauser 1/3; 4 кипер-ключа; перевод mint authority $CG на PDA `emission`.
- $CG mint (mainnet), USDC/SKR-адреса, `CG_MINT`/`TREASURY`/`BUYBACK_WALLET` для `scripts/setup.ts`.
- Pyth: Hermes API-ключ + payer-кошелёк pusher'а (≈2 SOL/мес), `set_params` на shard `0xCA75`.
- RPC-провайдер с WS/Geyser для индексатора (публичный devnet RPC для 50 tx/с не годится).
- Cloudflare Turnstile sitekey/secret; Sentry/uptime-мониторинг; домены `guttercaps.gg` / `app.guttercaps.gg`.
- Юрзаключение (lootbox BE/NL/UK, 18+), текст ToS/Privacy, art-мастера 90 фишек, иконки/баннер/скриншоты для Publisher Portal.
- Миграция казначейского SKR-кошелька `HPMr5r…` (сейчас single-signer — принятый риск) на мультисиг — **до** mainnet.

## 8. Что я не смог проверить в этой среде (и почему)

| Не проверено | Причина |
|---|---|
| `anchor build` / `cargo test` / `anchor test` | нет `cargo/rustc/anchor/solana`; `static.rust-lang.org`, `crates.io`, `index.crates.io` недоступны (SSL_ERROR_SYSCALL) |
| Localnet-сьют (77/83), CU-лимиты, `RENT_RESERVE`, T-D-03/04, `T-L-*` | нет скомпилированных `.so` (см. §3.4) и нет сети до Solana RPC (`api.devnet.solana.com`/`mainnet-beta` недоступны) |
| Нагрузочные тесты, TTI/Lighthouse, devnet-soak | нет стенда и нет `scripts/load` |
| Точный статус CI-шагов (`economy`/`client`/`backend`/`programs`) | логи GitHub Actions недоступны; вывод сделан по аннотациям API (billing) и локальному прогону |
| Фактическое поведение Switchboard при PDA-authority (SEC-C3 ч.2) | требует сети; только T-D-04 |

Верифицируемые утверждения этого документа воспроизводятся командами:

```bash
npm ci && npm run verify            # exit 0: economy OK · client 104/104 · backend 150/150 · landing 53/53
npm test                            # 83 skipped, exit 0  ← ложный «зелёный» (§3.3)
ls Cargo.lock target                # оба отсутствуют    ← G-0 не начинался
gh api repos/Leo88q/caps/actions/runs/<id>/jobs          # conclusion=failure, annotation = billing
npm audit --omit=dev                # 23 vulns (6 high)  (§5.6)
node -e '/* §5.1 */' && ls client/public                  # 518 KB gzip критический путь; иконок нет
```
