# 09 · Production readiness: аудит «что не доделано до деплоя»

> Проверка состояния репозитория `Leo88q/caps` (HEAD `067fadf`, ветка `arena/01a0afff-caps`) на дату 2026-09-17.
> Метод: всё, что заявлено в `docs/06`/`docs/08` как «сделано», прогонялось локально; то, что заявлено
> как «не собрано», проверялось по исходникам, по CI-API и по индексу crates.io.
> Никаких правок кода этот документ не содержит — это диагноз + план. План с тех пор исполнен частично,
> и что именно из него лежит в репозитории — в §0.1 и в блоках «Статус» после таблиц §4 и §5.

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


### 0.1 Что из этого документа уже закрыто кодом (обновлено 2026-09-17, HEAD `0c8b73c`)

Диагноз ниже не переписывается: он остаётся тем, что было найдено на `067fadf`. Отдельно фиксируется, что
из плана §4–§5 уже лежит в репозитории и проверяется локально, — потому что «не готово» и «не сделано» с
этой недели разные вещи, и путать их дорого.

**Гейты сдвинулись только там, где они зависели от кода.** G-0 (сборка), G-1 (P0-security на цепочке),
G-3 (соак), G-4 (внешний аудит) — без изменений и без права на компромисс: они упираются в `anchor build`,
деньги и ключи. Сдвинулись G-5/G-6/G-7 — ниже по строкам.

Ставится так (всё офлайн, `npm ci && npm run verify` → exit 0):

```
client 120 тестов · backend 215 (14 файлов) · economy инварианты+золото · landing 65/65
api:check    58 операций ⇄ 58 маршрутов (ни одной декларации без реализации и наоборот)
env:check    101/20/11/30 переменных, 0 дрейфа относительно .env.example
schema:check prisma ⇄ DDL: 72 задокументированных расхождения, 0 новых
bundle:check критический путь 296.6 KB gzip (бюджет 350 KB) + «switchboard не в entry-графе»
             + «ни один собранный ассет не ходит за шрифтами/стилями вовне» (index.html, dist CSS, dist JS)
e2e (CI)     8 тестов Playwright на прод-сборке с mock-API + axe на денежных экранах —
             зелёные на 5d69d68 (job `e2e`); из них же родом 4 исправленных бага, см. §5.4
```

Что это меняет в вердикте: продуктовый «последний километр», который можно было сделать кодом, сделан
(юр-слой, возраст, гео, бюджет, e2e-тир, axe, lighthouse-конфиг, наблюдаемость, shutdown, WS, Redis-стор,
контракты env/API/схемы БД). Что не меняет: **ни один ончейн-артефакт так и не существует**, и ни один из
пунктов, требующих сети, денег, ключей или чужого времени (Postgres-адаптер, соак, аудит, art), кодом не
закрыт. Поэтому формулировка «к продукту готовы, к деплою — нет» остаётся верной; изменилось то, что
между ними теперь лежит рабочий конвейер, а не список намерений.
### Статус по launch-gates (`docs/06` §1.4)

| Gate | Условие | Статус | Что мешает прямо сейчас |
|---|---|---|---|
| G-0 Compile | `anchor build` + `cargo test` зелёные, IDL, `keys sync` | ⛔ **0 %** | нет тулчейна/сети в среде разработки; 4 подтверждённых риска в `Cargo.toml` (§1) |
| G-1 P0 security | SEC-C1/C2/C3/H1/H2 + T-L-* зелёные | ⛔ блок | всё упирается в G-0; T-D-04 (CPI reveal) не проверялся нигде |
| G-2 Localnet | 77 сценариев зелёные в CI | ⛔ блок (лжёт уже не молча) | CI-джоб падает, если сьют ничего не выполнил (§3.3 исправлено); сами сценарии по-прежнему ждут `.so` |
| G-3 Devnet soak | 14 дней, ≥10 000 паков | ⛔ не начат | нет деплоя, нет devnet-ключа, нет `scripts/load`-ботов |
| G-4 Аудит | отчёт, Critical/High закрыты | ⛔ не начат | `docs/08` собран, но frozen commit/тег не проставлены; **скоуп в `docs/06` занижен в 2.4×** (§6.4) |
| G-5 Ключи/операции | Squads, pauser, runbook, алерты I1–I8 | 🟡 код · 2026-09-17 | мультисиги/pauser-ключи — по-прежнему владелец; в репозитории: `ops/deploy/runbook.md` (§0–§8, RU), `ops/monitoring/alerts.yml` — 15 алертов сверх I1–I8, `ops/backup/`, compose с секретами через `secrets:` |
| G-6 Нагрузка | LT-1..LT-6, таблица CU | 🟡 LT-1 · 2026-09-17 | `scripts/load/lt1.js` (k6) + `login.mjs` (реальный SIWS-хендшейк) + job `load-smoke`; LT-2..LT-6 осознанно не написаны — им нужны валидатор/соак/PvP-контур, список причин в `scripts/load/README.md`. Таблица CU не заполнена: нет `.so` |
| G-7 Продукт/право | ToS/Privacy, шансы, dApp Store | 🟡 код · 2026-09-17 | ToS/Privacy есть (7 локалей, цифры из `@guttercaps/economy`, `LEGAL_REVIEWED=false` рисует баннер «не вычитано»), гео-гейт работает (блокирует покупку, не игру), age-подтверждение 18+ есть. Не закрыто: юрзаключение, art-мастера 90 фишек, иконки/баннер/скриншоты для Publisher Portal (§5.3) |

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

### Статус §1 (2026-09-17)

| # | Статус | Что сделано |
|---|---|---|
| 1.1 | ✅ | `pyth-solana-receiver-sdk` оставлен как есть — включать нечего (у пакета нет ни одной feature), а вместо «доверять типу аккаунта» `programs/chip_core/src/pyth.rs` читает `UncheckedAccount` и сам проверяет 8-байтный `PriceUpdateV2::DISCRIMINATOR` + `try_deserialize(&data[..])`; равенство дискриминаторов закреплено тестом в том же файле |
| 1.2, 1.3 | ✅ подтверждено как «не чинить» | `features=["anchor"]` у `mpl-core 0.12.1` и `switchboard-on-demand 0.13.0` валидны (см. `features2` в `programs/*/Cargo.toml`); в CI-проверке графа это отдельная строка «разрешено по дизайну», а не ошибка |
| 1.4 | ⛔ владелец | `Cargo.lock` не может появиться без первой сборки; job `programs` генерирует его прогонно и отдаёт артефактом + warning, чтобы «pin» не выглядел ложным |
| 1.5 | ✅ | комментарий в `rust-toolchain.toml` ссылался на mpl-core 0.10 — переписан: 1.89.0 обоснован текущим набором (mpl-core 0.12.1 / anchor-lang 0.31.1 / pyth-sdk 1.0.1) и требует одной строки объяснения при подъёме |
| 1.6 | ⛔ упирается в G-0 | на сейчас 7 051 строка Rust и 28 `#[test]` (прирост с момента диагноза — из исправлений §1.1/§1.2 и golden-теста IDL); ни один тест ни разу не исполнялся, `cargo test --workspace` — шаг того же job |

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

### 3.4 Что действительно зелёное (прогон на момент диагноза: `npm ci && npm run verify` → exit 0)

> Числа ниже — снимок диагноза (client 104, backend 150, landing 56). Текущие — в §0.1 (client 120, backend 215, landing 65/65) и в `docs/08` §0. Таблица оставлена как есть, чтобы было видно, что прирост тестов идёт вместе с правками, а не вместо них.

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

### Статус §2 и §3 (2026-09-17)

| # | Статус | Что в репозитории | Что осталось |
|---|---|---|---|
| 2 | ✅ инструмент, ⛔ церемония | `scripts/program-ids.ts`: `new --out DIR` (4 cold-keypair'а → id + инструкция, ключи не пишутся в репозиторий), `apply --from DIR` (одним проходом переписывает **все** места синхронизации — `declare_id!`, секции `Anchor.toml`, дефолты `client/src/app/config.ts` и `backend/src/config.ts`, id в devnet-smoke, фикстуры localnet), `status` (в `verify`) и `check` (в job `programs`: keypair ⇄ declared ⇄ Anchor.toml). `[programs.mainnet]` в `Anchor.toml` заведён и явно объясняет, что совпадение с devnet — осознанный приём с ценой «утёк devnet-ключа = компрометация прода» | сама церемония: создать keypair'ы в холоде, перевести upgrade authority на Squads (chip_core+staking 3/5 + timelock 48 ч, market+arena 2/5, отдельный pauser 1/3), `economy:check` после применения, тег frozen-commit для аудиторов. Ни один из шагов не исполняется из этой среды |
| 3.1 | ✅ закрыто фактом | прогоны пошли: `5d69d68` — 7 джобов исполнено за 1м52с, 6 зелёные (economy · client · e2e · backend+api · landing · security), красный только `programs`, и ровно на `cargo fmt` | ничего: биллинг Actions — не код; но «ни одного зелёного прогона в истории» больше не верно, и это был единственный реальный блокёр G-0 |
| 3.2 | 🟡 артефакты есть, деплой-джоба нет | `ops/deploy/`: `Dockerfile.api`/`Dockerfile.client`/`Dockerfile.backup`, `nginx.conf` (CSP/gzip/immutable/cache split, upgrade для `/ws`), `docker-compose.yaml` (api×N + redis + prometheus, секреты через `secrets:`), `runbook.md` §0–§8 с порядком rollout/rollback и проверок после | deploy-workflow не написан намеренно: без хоста и секретов он был бы unverifiable-пайплайном, а это ровно то, что §3.3 ругает CI за «зелёный». Как только есть куда деплоить — 3 шага: build+push образов, `solana-verify submit`, rollout по runbook §2. `prisma migrate deploy` появится вместе с вариантом B из `ops/deploy/data-layer.md` |
| 3.3 | ✅ | локально тот же набор, что и в CI: `npm run programs:gate` (fmt + clippy `-D warnings` + `cargo test`), правится — `npm run programs:fmt`; red-джоб `programs` на `cargo fmt` поэтому воспроизводится одной командой, а не гаданием. fail-fast включён: job `programs` **блокирующий** (fmt, clippy `-D warnings`, `cargo test`, `anchor build --features localnet`), localnet-сьют падает, если не выполнил ни одного теста (guard по `--reporters=json`, «no tests ran» = red), typecheck спеков (`tsc -p tests/localnet`) в job `api`. Единственное понижение — отчёт о дублях в графе зависимостей: он стал диагностикой, потому что без `Cargo.lock` его exit code мерил оболочку, а не граф (дважды красил PR по ложной причине: сперва на намеренном соседстве `solana-program` v2+v3, потом падением с exit 2) | снять `continue-on-error` с `localnet` и ночных джобов — сразу после первого зелёного `anchor build`; это строка владельца G-0, а не задачи кода |
| 3.4 | ✅ числа живые | актуальные счётчики — в §0.1 и в `docs/08`; расхождение «91/111 в docs/08, 73/23 в docs/06, 25/17 `#[test]`» устранено переписью по факту (2026-09-17) | пересчитывать после каждого крупного чанка — смысл в том, что аудитор сверяет именно это |

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


### Статус §4 (2026-09-17): что закрыто кодом, а что ждёт

| # | Статус | Что лежит в репозитории | Что осталось |
|---|---|---|---|
| 4.1 | 🟡 только гейт | `scripts/schema-drift.ts` сверяет `backend/prisma/schema.prisma` с DDL, который реально исполняется (все файлы `backend/src`, не только `db.ts`); расхождения — в `backend/prisma/drift.json` (72), `--check` не даёт списку расти и не даёт держать в нём уже исправленное. Гейт нашёл и починил и починил 3 настоящих расхождения: у `events_raw` не было колонки упорядочивания, по которой идёт replay (`ORDER BY slot, id`); `IndexerCursor` был описан как `last_sig/last_slot`, тогда как индексатор пишет `newest_signature/newest_slot/history_complete` (первая же запись на Postgres упала бы); `Session` хранил `nonce/ip/ua` и не хранил `csrf` — то есть терял CSRF-защиту и противоречил собственному тексту о приватности | сам адаптер (34 SQLite-специфичных места), `prisma migrate deploy` в CI, решение «SQLite+LVM-диск с задокументированным RPO» vs Postgres. Ни того, ни другого кода здесь нет: нет Postgres в среде, нет `@prisma/client` в зависимостях. Это 3–5 дней и выбор владельца. Цена посчитана, а не оценена — `ops/deploy/data-layer.md`: 77 мест диалектного SQL (30 `INSERT OR IGNORE`, 21 `ON CONFLICT`, 10 `PRAGMA`, 7 `COLLATE NOCASE`, 9 `json_extract`, 4 `AUTOINCREMENT`; `strftime`/`RETURNING`/`fts5` — ноль), 241 вызов `db.*` в 21 файле; дорогает не SQL, а переход синхронной обёртки на async. Там же — вариант «A: SQLite + LVM» с RPO ≤ 1 ч по факту имеющегося `ops/backup/sqlite-backup.sh` (read-model всё равно восстанавливается из цепи) и явные триггеры перехода в Postgres |
| 4.2 | ✅ в коде | `backend/src/redis.ts` — `createRedisGuard` (Lua: INCR+PEXPIRE+PTTL, 250 мс на вызов, fail-open при отказе Redis), `RATE_LIMIT_REDIS_MAX=900`/`RATE_LIMIT_REDIS_WINDOW_MS=60000`; общий стор — единственное, что делает лимиты осмысленными при >1 реплике; `ops/deploy/docker-compose.yaml` поднимает `redis:7.4.2-alpine --maxmemory-policy noeviction` (noeviction — чтобы «лимитов нет» не стало режимом работы под давлением памяти) | нет живого прогона на 2 репликах (нужен контур) и нет тестов против реального Redis — в CI фикс с EVAL-стабом |
| 4.3 | ✅ в коде | `backend/src/ws.ts`: `WS_PATH=/ws`, `WS_MAX_CLIENTS=500` (перебор → 1013), `WS_PING_MS=30000`, `WS_MAX_BACKLOG_BYTES=1 MiB` (медленный клиент отключается, а не копится), апгрейд в `nginx.conf`, `EVENT_BUS=inproc\|redis\|off` с явной проверкой конфигурации (`EVENT_BUS=off` не даёт молча деградировать в polling) | реальный поток из Geyser/WS-RPC не воспроизведён: провайдер с WS — блок владельца |
| 4.4 | ✅ в коде | `backend/src/shutdown.ts` + `main.ts`: SIGTERM → `server.close()`, `/readyz` отвечает 503 на время дрена, crank дорабатывает текущую итерацию, `SHUTDOWN_TIMEOUT_MS=25000` с проверкой, что значение вообще оставляет время на дрена | — (проверялось юнит-тестами, не убийством прод-процесса) |
| 4.5 | ✅ в коде | заголовки в `ops/deploy/nginx.conf` (`CSP` c `connect-src` по RPC-доменам, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `frame-ancestors 'none'`); HSTS оставлен закомментированным — TLS терминирует платформа, и включать его до этого значит запереть себе домен; 500-й ответ = `{code:'internal', requestId}` без текста внутреннего исключения, `x-request-id` на каждом ответе | Sentry/error-tracking (нужен DSN) и проверка заголовков живым прогоном (HSTS/preload) |
| 4.6 | ✅ в коде | `/metrics` (`backend/src/metrics.ts`: счётчики/гейджименты + `metrics_series` как canary кардинальности), `/healthz` (только процесс) vs `/readyz` (БД читается, события есть, лаг индексатора, Pyth свежий, нет abandoned crank-задач), JSON-логи `log.ts`, `ops/monitoring/alerts.yml` — 15 алертов (ApiDown, IngestLag/Stalled, CrankHeadStuck/Backlog/BalanceLow, PythCacheStale, SwitchboardQueueBacklog, HandleLeak, WsSaturation, CardinalityCanary, RestartLoop, …) и `prometheus.yml` | алерты ни разу не висели на живом Prometheus; скриншотов графика нет (и не будет из этой среды) |
| 4.7 | ✅ | `npm run api:check` (каждая операция openapi ⇄ каждый маршрут; сейчас 58 ⇄ 58) в `verify` и в CI; `/collections/{idx}/chips/{rarity}` из 404 превращён в реализованный маршрут; CI job `client` регенерит `schema.d.ts` и падает на рассинхроне | — |
| 4.8 | ✅ контракт | `env:check`: 101 (backend) / 20 (client) / 11 (pusher) / 30 (deploy) переменных, 0 дрейфа, значения — литералы из кода; `config.ts` отказывается стартовать на бессмысленных комбинациях (Redis-only режимы, `SHUTDOWN_TIMEOUT_MS`, `EVENT_BUS=redis` без `REDIS_URL`); секреты в compose — через `secrets:`, а не env-строки | сами ключи (4 кипера, pauser, Hermes, payer) — владелец; `docker build` здесь не запускается |
## 5. Клиент и продукт

| # | Проблема | Доказательный факт | Что сделать |
|---|---|---|---|
| 5.1 | **Перфоманс-бюджет нарушен на 48 %**: цель `docs/06` §1.3 — ≤ 350 KB gzip на критическом пути, фактически **518.2 KB** (index 52.7 + react 86.4 + solana 89.6 + wallet 52.0 + switchboard 228.8 + css 8.7). Правило «Switchboard — только dynamic import» не выполнено: `switchboard` вынесен в `manualChunks` и предзагружается `<link rel=modulepreload>` из `dist/index.html` | мой замер `dist/` после `vite build` | убрать `switchboard` из `manualChunks` (ленивый `import()` внутри `usePackFlow`), проверить 4-й чанк `wallet`; цель ≤ 350 KB. 0.5–1 день |
| 5.2 | Юридический слой не собран: ToS/Privacy нет вообще (в лендинге 10 «выключенных» ссылок `href="#"`), при этом `dapp-store/PORTAL_CHECKLIST.md` требует резолвящиеся URL Privacy/Terms/copyright; age-gate 18+ (PRD §7 «18+») не реализован; **гео-гейт — заглушка**: бэкенд жёстко возвращает `geoRestricted: false`, флаг `VITE_FLAG_GEO_GATE` по умолчанию `false`, а lootbox-регулирование BE/NL — задокументированный риск | `grep geoRestricted backend/src/queries.ts:118`; `ls` по репо — нет terms/privacy; `client/.env.example` | 2 статичные страницы (7 локалей) + ссылка в футере/модалке + реальная гео-проверка (GeoIP на входе в checkout, решение «блок покупки, не блок игры») + юрзаключение до mainnet (владелец) |
| 5.3 | Контент для магазина и кошельков отсутствует: `icon-192.png`, `icon-512.png` (512 — без альфы), `banner.png 1200×600`, ≥4 скриншота 1080p, `og.png` (на который ссылается `client/index.html`). `client/public/` = 3 файла, из них `ICONS_NEEDED.txt`. Арт 90 фишек — процедурный SVG-плейсхолдер, ТЗ художнику готово (`docs/07`) | `ls client/public`; `dapp-store/media/README.txt`; `client/src/shared/ui/ChipArt.tsx:1` | владелец/дизайнер: мастера → пайплайн нарезки → CDN. Это внешний блокер dApp Store-эксклюзива, а не кодерский |
| 5.4 | E2E-контур не начат: `docs/06` §3.7 описывает Playwright (T-E-00..13, включая MWA на Android), в репозитории нет ни `playwright.config`, ни `tests/e2e`. `tsc -p tests/localnet` в CI — единственная проверка типов спеков | `find . -name "*playwright*"` → пусто | 1 день на T-E-00 (петля на devnet одним кошельком 3×) — это и есть определение «готово»; без него G-3 не подписать |
| 5.5 | Нет Lighthouse CI и axe (обе цели §1.3: TTI ≤ 3.5 с, WCAG AA на денежных экранах) | отсутствие конфигов | 1 день на `lhci` + `@axe-core/playwright` в e2e |
| 5.6 | Зависимости клиента тянут устаревший Node-путь: 23 npm-уязвимости в **prod**-дереве (6 high: `bigint-buffer`, `toml`, и транзитивно `@coral-xyz/anchor`, `@solana/spl-token`, `@solana/buffer-layout-utils`, `@switchboard-xyz/on-demand`), dependabot/renovate не настроен, `SECURITY.md` нет, `LICENSE` нет, в git закоммичен `.DS_Store` | `npm audit --omit=dev`; `ls .github` → только `workflows` | `dependabot.yml` (npm + cargo), `npm audit fix`-PR, `LICENSE` (или `UNLICENSED`), `git rm --cached .DS_Store`, `SECURITY.md` с политикой bounty из `docs/08` §6 |


### Статус §5 (2026-09-17)

| # | Статус | Что закрыто | Что осталось |
|---|---|---|---|
| 5.1 | ✅ | 518.2 → **296.6 KB** gzip на критическом пути (замер локально). `switchboard` убран из `manualChunks` (228 KB — только по динамическому `import()` в момент подписи), проверен 4-й чанк (`wallet`), `manualChunks` сведён к solana/wallet/react. Бюджет перестал быть числом без владельца: `scripts/bundle-check.ts` (`npm run bundle:check`) читает `dist/index.html`, считает gzip по фактическому списку предзагрузок, падает на превышении, на наличии switchboard в entry-графе и на off-origin ссылках в собранном HTML | TTI ≤ 3.5 с p75 на Seeker/Pixel-6-классе по 4G — не измерен: нужна прогонка на стенде (`lighthouserc.cjs` — приближение, не замена). Плюс шрифты: их теперь нет ни в CDN, ни в репозитории (см. 5.3/`client/public/fonts/README.md`), и это единственный пункт §5.1, где «стало легче» временно означает «не стало красивее» |
| 5.2 | ✅ в коде | `client/src/shared/lib/legal.ts` + `features/legal/Legal.tsx`: Terms и Privacy как структурированные данные, EN-канон, 7 локалей для обвязки, `canonicalLegalUrl`, алиасы `/terms` `/privacy`; номера комиссий/шансов/размеров паков подставляются из `@guttercaps/economy`, поэтому расхождение «текст ↔ контракт» = падение теста. `AgeGate` (18+, подтверждение хранится локально, версия `18:<LEGAL_EFFECTIVE>` — серверной записи нет ровно потому, что privacy-страница обещает обратного). Гео: `backend/src/geo.ts` — блок покупки, не блок игры; страна из одного заголовка edge (`X-Geo-Country` ← `cf-ipcountry`) и только при `GEO_TRUST_HEADER=1`; `GEO_UNKNOWN=allow` = «гейта нет, и это видно», `block` = не продаём никому; `geoMisconfiguration()` не даёт в проде поднять процесс с «гейт включён, но заголовку не доверяют» или с пустым списком. Флаги `VITE_FLAG_*` — только UI, никогда не гейт | юрзаключение (lootbox BE/NL/UK), вычитка текстов, `LEGAL_REVIEWED=true` (флаг владельца — до него на страницах висит баннер «не вычитано»), перевод самих текстов на 6 языков |
| 5.3 | ⛔ внешний блокёр | добавлен только `client/public/fonts/README.md` — рецепт self-host-шрифтов (файлы, подмножества latin/latin-ext/cyrillic, `@font-face` с `font-display: swap`, OFL), и из `index.html` убран Google Fonts: прод-CSP (`font-src 'self' data:`) эти файлы всё равно не пропускал, то есть в проде шрифт не грузился никогда, а запрос с IP посетителя уходил на каждую загрузку | мастера 90 фишек, `icon-192/512`, `banner.png` 1200×600, 4×1080p, `og.png` (на него ссылается `client/index.html`) — это работа дизайнера и условие эксклюзива dApp Store, а не кодера |
| 5.4 | ✅ PR-тир зелёный (CI, `5d69d68`) | `playwright.config.ts` + `tests/e2e/mock-shell.spec.ts` (job `e2e`, блокирующий): прод-сборка с `VITE_API_MOCK=1` на `vite preview` (не dev-сервер — автодетект мока в клиенте живёт только в dev), 8 тестов: шелл рисуется и ни один запрос не уходит за origin; все публичные маршруты рисуются без `pageerror`; кошелёк-гейт редиректит с `?next=`; 4 SKU с шансами и clean-zone; юридические ссылки и резолв алиасов; `html lang` за сменой локали; axe на денежных экранах. Два прогона в CI нашли 4 настоящих бага: `role=tablist` без `role=tab` (axe, critical) и три способа ходить за шрифтами вовне — `<link>` в `index.html`, `@import` в CSS кошелькового UI, и инъекция `<link>` из MWA-пакета (последние два — уже после того, как HTML был вычищен: проверка только HTML их бы не увидела). Все исправлены; a11y-часть закреплена юнит-тестом без браузера, «не ходим вовне» — `bundle:check` по dist CSS/JS | `tests/e2e/devnet-loop.spec.ts` (T-E-00) — скелет: порядок шагов и ассерты по спеке, но селекторы попапа Phantom **никогда не исполнялись** (в этой среде нельзя скачать браузер), и файл говорит об этом в шапке; нужен один ручной `--headed --debug` с unpacked-расширением и funded-сидом. Ключ-логин «вставь seed» в клиент не добавлен намеренно — это решение безопасности, а не тестовое удобство |
| 5.5 | ✅ конфиг, ⛔ замер | `lighthouserc.cjs`: `error` — только на детерминированное (размеры скриптов, total-byte-weight, render-blocking, `font-display`, text-compression), `warn` — TTI/LCP/CLS: модель throttling на общем раннере не является p75 на реальном устройстве, а гейт, который нельзя починить, через месяц отключают; отчёт пишется в `test-results/lighthouse`, а не в публичный google-сторедж. Job `lighthouse` — ночной, `continue-on-error` (пока человек не увидит его зелёным дважды). axe — в PR-тире, serious+critical, на `/shop` и `/market` | прогон на стенде/устройстве (TL;DR: цифры «≤ 3.5 с» в `docs/06` §1.3 до этих пор остаются необязательством) |
| 5.6 | 🟡 | `.github/dependabot.yml` (npm + cargo), `LICENSE`, `SECURITY.md` с политикой из `docs/08` §6, `.DS_Store` удалён из индекса; job `security` падает на critical и печатает warning на high, плюс проверка «нет закоммиченных keypair'ов вне фикстур» | `npm audit --omit=dev` = 23 (7 прямых: 3 high — `@coral-xyz/anchor`, `@solana/spl-token`, `@switchboard-xyz/on-demand`) с `range: *` — **фиксов у апстрима нет**, поэтому `audit fix` здесь не команда, а ожидание; список и обоснование — в `SECURITY.md`. Переход на `@solana/web3.js` v2 (или `@solana/kit`) — отдельная задача с ончейн-проверкой, не PR «обнови версии» |
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


### Что из недель 1–3 уже в репозитории (2026-09-17)

Неделя 1 (сборка, ключи, program-ids) — **не сдвинулась**: это `anchor build`, Actions-биллинг и церемония
ключей. Недели 2–3 из таблицы выше сделаны кодом, кроме Postgres-адаптера (4.1) и замеров на стенде:

- «Redis-стор лимитов (4.2)», «`helmet`/CSP + `internal_error` (4.5)», «`/metrics` + 8 алертов (4.6)»,
  «`backend/.env.example` (4.8)» — готовы (см. статус §4);
- «инфраструктура: Dockerfile ×3 + compose + deploy-workflow + rollback» — манифесты есть
  (`ops/deploy/`, `runbook.md` §0–§8), ни один `docker build` здесь не запускался (Docker в среде отсутствует),
  выкладка — владелец;
- «клиент: перфоманс (5.1) · юр-страницы + гео/age (5.2) · E2E T-E-00 (5.4) · Lighthouse/axe (5.5) ·
  dependabot/LICENSE (5.6)» — готовы в объёме, который проверяем без сети и браузера (см. статус §5);
- «LT-1 k6» — скрипт есть и прогоняется (job `load-smoke`), LT-2..LT-6 — намеренно нет;
- «crank-soak-боты на 10 000 паков» — нет (нужен devnet и оплаченный payer).

Отдельно, чтобы это не выглядело лучше, чем есть: **`localnet`-джоб по-прежнему скипается** (нет `.so`), и
именно он остаётся единственным настоящим доказательством ончейн-корректности. Всё, что зелёное здесь,
зелёное в офлайне.
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

Верифицируемые утверждения этого документа воспроизводятся командами (левая колонка — как было на
`067fadf`, правая — что они показывают сейчас, на 2026-09-17):

```bash
npm ci && npm run verify     # было: client 104 · backend 150 · landing 53
                             # стало: client 120 · backend 215 · economy · landing 65/65
                             #       api:check 58⇄58 · env:check 0 дрейфа · schema:check 0 новых
                             #       · bundle:check 296.6 KB ≤ 350 KB
npm test                     # 83 skipped, exit 0 — ложный «зелёный» (§3.3) сам по себе жив;
                             # в CI такой прогон падает («no tests ran»), `.so` по-прежнему нет
ls Cargo.lock target         # оба отсутствуют → G-0 не начинался (и не может начаться здесь)
npm audit --omit=dev         # 23 (7 прямых, 3 high) — у всех `range: *`, фиксов апстрима нет (§5.6)
ls client/public             # 3 файла: ICONS_NEEDED.txt, favicon.svg, manifest.json — §5.3 как есть
ls client/dist/*.html >/dev/null && grep -c 'https\?://' client/dist/index.html   # 0 — ни одной
                             # off-origin ссылки в собранном HTML (§5.1/§5.2, новый гейт)
npm run e2e:types            # typecheck спеков — единственное, что Playwright-тиры проходят в этой среде
npm run schema:check         # prisma ⇄ DDL: 49 таблиц / 54 модели / 72 задокументированных расхождения
```

### Чего по-прежнему нельзя проверить в этой среде (и почему это важно читать именно так)

| Не проверено | Причина и что с этим делать |
|---|---|
| Любой прогон в браузере (Playwright mock-тир, Lighthouse, axe в браузере) | `npx playwright install chromium` → «Download failure, code=1»: CDN недоступен. Специки исполняются **только в CI** (job `e2e`) — и там они зелёные с `5d69d68`; локально им доступна лишь проверка типов. Отсюда правило: «8 тестов» в §5.4 — это прогон в CI, а не мой |
| k6 / docker / `docker build` | бинарников нет; `load-smoke` в CI запускает k6 в контейнере (`grafana/k6:latest`), compose остаётся статически проверенным манифестом |
| `login.mjs` под нагрузкой | **проверено**: локальный API на `:memory:`, полный SIWS-хендшейк (`nonce → подпись → /v1/me`) вернул профиль — из 5-ти строк таблицы §4 единственная, которую удалось исполнить целиком |
| Ончейн (`anchor build/test`, localnet, CU, T-D-*) | нет Rust/Anchor/Solana и сети до crates.io/RPC — §8 исходного аудита в силе |
| Логи GitHub Actions | `*.blob.core.windows.net` недоступен (EOF); восстановление по `gh api …/jobs` (статусы шагов) и `…/annotations` (тексты падений) — так и были найдены оба бага §5.4 |


