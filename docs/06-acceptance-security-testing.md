# GUTTERCAPS — Приёмка, безопасность, тестирование и нагрузка

> Фаза 6 · v1.0 · Чеклист приёмки (PRD §3.4), security-review четырёх программ + бэкенда + клиента, план тестирования, план нагрузочного теста и оценка compute units на пике вскрытия паков.
> Источники истины: `programs/*` (Rust, **не компилировался** — см. `programs/README.md` → Status), `packages/economy`, `backend/`, `client/`, `docs/02-economy.md`, `docs/03-architecture.md`, `docs/04-frontend.md`.

---

## 0. Как читать этот документ

**Что проверено фактически (обновлено после решений владельца по §5 — SKR-пул, окно возврата):**

| Слой | Проверка | Результат |
|---|---|---|
| Экономика (`packages/economy`) | `npm run economy:test` (node:test) · `economy:check` (инварианты §1–8 + golden + sync-check, вкл. SKR-константы) | 12/12 · golden 64 векторов · OK |
| Клиент (`client/`) | `tsc` strict · `vitest` (`app/smoke`, `chain/chain` вкл. маршрутизацию claim $CG/SKR, `shared/i18n`) · `vite build` | OK · 73/73 · OK |
| Бэкенд (`backend/`) | `tsc` · `vitest` (auth, services, events/borsh — 30 событий, ingest idempotency, projections вкл. SKR-леджер, queries) | OK · 23/23 |
| Лендинг | `npm run landing:check` (DOM-проверки happy-dom + smoke) | 53/53 |
| Программы (`programs/*`) | `anchor build` / `cargo test` (17 `#[test]` + `tests/golden.rs`) | **не запускались** — нет тулчейна в среде разработки |

**Что это значит для приёмки.** Всё, что ниже относится к on-chain коду, — это (а) статический ревью исходников, (б) сверка с документацией внешних зависимостей (Switchboard On-Demand 0.13.0, mpl-core 0.12.1, pyth-solana-receiver-sdk 1.0.1), (в) план тестов, которые должны быть прогнаны после первого успешного `anchor build`. Ревью выявил **три критических дефекта в схеме commit-reveal** (SEC-C1…C3) и **три высоких** (SEC-H1 — id Switchboard по кластерам, SEC-H2 — пауза за 48-часовым timelock, SEC-H3 — бэкенд без rate-limit; H1 и H3 уже закрыты), см. раздел 2.2. Критические блокируют деплой даже на devnet и вынесены в P0 «до компиляции».

**Система идентификаторов.** `ACC-n` — критерий приёмки; `SEC-Xn` — finding (C критический / H высокий / M средний / L низкий / I информационный); `T-U/R/P/L/B/E/D-n` — тесты (unit-TS / Rust-host / property / localnet / backend / e2e / devnet); `LT-n` — нагрузочный сценарий; `G-n` — launch-gate.

---

## 1. Чеклист приёмки

### 1.1 Петля end-to-end (критерий из ТЗ, PRD §3.4)

`connect → buy pack → open pack (VRF) → see chip in collection → fuse dupes → list on market → play PvP → stake $CG → claim`

| # | Шаг | Что считается «работает» (наблюдаемые факты) | Где доказательство | Тесты | Статус сейчас |
|---|---|---|---|---|---|
| ACC-1 | **connect** | Wallet Adapter (Phantom/Solflare/Backpack) и MWA (Seeker) подключаются; SIWS: `POST /auth/siws/nonce` → подпись → `POST /auth/siws/verify` → cookie `gc_session` (HttpOnly) + `csrf`; `GET /me` = 200; повтор nonce = 401; неверная подпись = 401; язык UI переключается (7 локалей) и сохраняется | `backend/src/auth.ts`, `client/src/features/language` | T-B-01..03 ✅ · T-U-i18n ✅ · T-E-01 | ✅ backend/клиент; e2e — план |
| ACC-2 | **buy pack** | `buy_pack(sku, qty≤25, currency, nonce, max_lamports)`: создаётся `PendingPack` (оплата в `vault`, `liab_*` += , резерв ренты `0.006 SOL × chips`), в той же tx — `randomness_init + randomness_commit`; SOL/SKR-цена через Pyth (наши push-аккаунты shard 0xCA75, docs/03 §2.9) не старше 60 с, slippage ≤ `max_lamports` из `/packs/quote`; SKR −5 %; бандлы −7/−12/−18 %; при `paused` — отказ; событие `PackBought` попадает в индексатор → `GET /me/pending` | `packs.rs:98–222`, `client/src/chain/flows/packFlow.ts`, `backend/src/projections.ts` | T-R-01..04 · T-L-C01..C06 · T-B-06 ✅ · T-E-02 | ⛔ до G-0 (не компилировалось) |
| ACC-3 | **open pack (VRF)** | `open_pack(nonce, pack_no)` в одной tx с `randomness_reveal`: N ассетов Metaplex Core (PDA `["asset", pending, pack_no, i]`) + `ChipState`; редкости/коллекции совпадают с `expandRandomness` (golden 64); pity обновлён; на последнем паке — burn 75 % $CG / 25 % treasury, `PendingPack` закрыт, остаток резерва вернулся покупателю; экран `/verify` воспроизводит ролл по `randomness` + `PackOpened`; после стейл-окна без reveal — `cancel_stale_pack` возвращает 100 % | `packs.rs:284–458`, `economy.rs::expand`, `packages/economy/golden/pack_expand.json`, `client/src/features/verify` | T-R-05..09 · T-P-01..03 · T-L-C07..C14 · T-E-03 | 🟡 C1/C2 + C3-часть 1 исправлены в коде; ждёт `anchor build` + T-L-C07..C14 |
| ACC-4 | **see chip in collection** | Индексатор: `PackOpened` → `chips` projection, `GET /me/chips`, `GET /me/grid` (10 × 9), деталь `GET /chips/{asset}`; re-ingest идемпотентен; `rebuild` = чистая функция от `events_raw`; сетка отображает 90 ячеек, пустые/заполненные, бонус сета | `backend/src/projections.ts`, `client/src/features/collection` | T-B-10..15 ✅ · T-E-04 | ✅ backend; e2e — план |
| ACC-5 | **fuse dupes** | Рецепты 0–3 (100 %): атомарный burn ×3 + mint результата, `fee_cg` сожжён, lock результата; рецепты 4–7: `fuse` (commit, фризим материалы `F_FUSING`) → `fuse_reveal` (успех → mint; провал → burn 2, возврат 1); бустер +15 п.п. (cap 95 %) списывается из `PlayerItems`; правило «same-collection» на чётных шагах; `cancel_stale_fusion` размораживает материалы | `fusion.rs`, `packages/economy/src/fusion.ts`, `client/src/features/fusion` | T-R-10..12 · T-L-F01..F08 · T-B-20 ✅ · T-E-05 | 🟡 C1/C2 + C3-часть 1 исправлены в коде; ждёт `anchor build` + T-L-F01..F08 |
| ACC-6 | **list on market** | `list` (0.5 $CG сжигается, `F_LISTED` через CPI `set_chip_flag`, цена ≥ min) → `buy` (`expected_price`/`currency` guard, self-trade запрещён, split: fee ≤ 10 % → ⅓ buyback / ⅔ treasury, 2.5 % royalty) → `cancel`/`update_price`; офферы USDC с TTL; floor-матрица `/market/floor` | `market/src/lib.rs`, `backend/src/queries.ts` | T-R-13 · T-L-M01..M09 · T-B-21 ✅ · T-E-06 | ⛔ до G-0 |
| ACC-7 | **play PvP** | Обычный матч: очередь → серверный расчёт (seed = sha256(matchId‖commitA‖commitB‖secret)) → результат в `/arena/matches/{id}`, награды 2/0.5 $CG (≤ 8 матчей/день); wager-матч: `create_battle` (эскроу $CG, 3 фишки, лига) → `accept_battle` (≤ 10 мин, та же лига) → `resolve_battle` (oracle, rake 5 % = 40/40/20) или `cancel_stale_battle` (≥ 30 мин) | `arena/src/lib.rs`, backend arena (501 — не реализовано) | T-R-14..15 · T-L-A01..A07 · T-B-30..34 · T-E-07 | ⛔ бэкенд arena не реализован; контракт до G-0; **SEC-H2** |
| ACC-8 | **stake $CG** | `stake_cg` тиры flex/30/90/180 (boost 1.0/1.5/2.2/3.0), `unstake_cg` с early-exit burn 0/5/10/15 %, `claim` из token-pool; `stake_chip`/`unstake_chip` через CPI `set_chip_flag(F_STAKED)`, `sync_set_bonus` (≤ 10 сетов); `tick_day` раз в сутки делит guarded-бюджет по сплиту 30/15/17/23/15 | `staking/src/instructions/*.rs`, `packages/economy/src/staking.ts` | T-R-16..20 · T-L-S01..S09 · T-E-08 | ⛔ до G-0; **SEC-M1** (burn-guard мёртв) |
| ACC-9 | **claim** | `publish_root(kind, epoch, root, budget)` резервирует бюджет слайса; `claim_root` после `ROOT_TIMELOCK` (1 ч) с Merkle-proof (≤ 24, leaf = keccak(0x00‖wallet‖amount‖kind‖epoch)), receipt PDA запрещает повтор; `revoke_root` возвращает бюджет. **SKR (kind 5–7):** `publish_skr_root` резервирует из `SkrPool.budget`, `claim_skr_root` переводит из vault пула (без минта), `revoke_skr_root`; кросс-валютный claim → `WrongRootCurrency` | `emission.rs:222–320`, `skr.rs`, `client/src/chain/ix/staking.ts` (`claimAnyRootIx`) | T-R-21..23 · T-P-04 · T-L-S10..S20 · T-E-09 | ⛔ до G-0 |

**Определение готовности петли:** все 9 шагов проходят подряд одним кошельком на devnet-стенде скриптом `T-E-00` (Playwright, реальный devnet, Switchboard devnet-очередь) три раза подряд без ручного вмешательства; индексатор догоняет каждое событие ≤ 5 с; ни один `PendingPack`/`PendingFusion`/`WagerBattle` не остаётся в подвешенном состоянии.

### 1.2 Функциональные критерии по областям (сокращённо)

| Область | Критерии |
|---|---|
| Магазин | 4 SKU с ценами из `GameConfig` (не из клиента); квота `/packs/quote` с `priceUpdateAccount`, `maxLamports`, `switchboardQueue`; odds-таблица и pity видны до покупки (ACC-3 «честность»); Starter — 1/кошелёк, soulbound 7 д; Limited — окно события и лимит 5/день |
| Вскрытие | Анимация можно пропустить (PackSkipAnim — платная услуга) без влияния на результат; при обрыве соединения пак виден на Home и в `/shop/opening/:nonce`; кнопка возврата появляется только после стейл-окна |
| Коллекция | Сетка 10 × 9, фильтры (район/редкость/статус), 60 fps на 90 карточках (mid-range Android), процедурный SVG до прихода арта |
| Fusion | Верстак показывает шанс, fee, lock результата и что произойдёт при провале до подписи; предложение материалов из дублей (`/fusion/suggest`) |
| Маркет | Фильтры (район, редкость, валюта, цена), floor по архетипу, история сделок, комиссия и роялти показаны в «чистой зоне» (trust blue) |
| Стейкинг | Калькулятор APR из `/staking/estimate` совпадает с on-chain расчётом ±0.1 %; early-exit предупреждение с суммой сжигания |
| Квесты | Прогресс только по on-chain событиям/серверным матчам; клейм недоступен кошелькам < 24 ч без платного пака (или отложен) |
| Профиль/лидерборд | Хэндл покупается через `pay_service` (ref_hash) и виден в лидерборде ≤ 5 с |
| Админ-панель | Любой `set_params` проходит валидацию `packages/economy` в UI и повторно в контракте; изменения журналируются (`ParamsChanged` + `economy_params`) |
| i18n | 7 локалей (EN/PT/ES/VI/ID/FIL/RU) без `undefined`/пустых строк (тест `shared/i18n`), переключатель в табе, вёрстка адаптивна к длине строк (VI/ID/RU +30–40 %) |

### 1.3 Нефункциональные критерии

| Метрика | Цель | Как измеряем |
|---|---|---|
| TTI клиента (Seeker / Pixel 6 class, 4G) | ≤ 3.5 с | Lighthouse CI, p75 |
| Bundle критического пути | ≤ 350 KB gzip (Switchboard SDK — только dynamic import) | `vite build` report |
| API p95 (кэшируемые чтения) | ≤ 150 мс при 2 000 rps | k6 (LT-1) |
| API p95 (`/me/*`, авторизованные) | ≤ 250 мс при 300 rps | k6 (LT-1) |
| Лаг индексатора | p95 ≤ 5 с, p99 ≤ 15 с при 50 tx/с | LT-3 |
| Crank: commit → PackOpened | p50 ≤ 8 с, p95 ≤ 20 с | LT-2a/2b, LT-4, devnet soak |
| Доля «зависших» pending > 1 ч | 0 (любое значение > 0 — инцидент) | алерт в мониторинге |
| Доступность API | 99.9 % / мес | uptime-мониторинг |
| A11y | WCAG 2.1 AA на денежных экранах (контраст «чистой зоны», фокус, ARIA у сетки) | axe в Playwright |

### 1.4 Launch gates

| Gate | Условие | Кто подписывает |
|---|---|---|
| G-0 Compile | `anchor build` + `cargo test --workspace` (16 unit + golden 64) зелёные; IDL сгенерированы; `anchor keys sync` + обновлены `chip.rs:20–22` | tech lead |
| G-1 P0 security | SEC-C1, C2, C3, H1, H2, H3 исправлены и покрыты тестами T-L-C10..C14, T-L-F06..F08, T-L-A05..A06, T-B-40; повторный внутренний ревью | tech lead + второй ревьюер |
| G-2 Localnet suite | Раздел 3.5 полностью зелёный в CI (≥ 60 сценариев), Switchboard-мок и Pyth-фикстуры | QA |
| G-3 Devnet soak | 14 дней: ≥ 10 000 паков ботами, 0 зависших pending, crank p95 ≤ 20 с, ≥ 500 fusion (≥ 100 рискованных), ≥ 200 wager-матчей | QA + backend |
| G-4 Аудит | Внешний аудит 4 программ (~2.4 k LOC) + отчёт; все High/Critical закрыты, Medium — закрыты или принят риск письменно | founder |
| G-5 Ключи и операции | Squads 3/5 (chip_core, staking) + 48 ч timelock, 2/5 (market, arena); отдельный «горячий» ключ паузы 1/3; runbook инцидентов; алерты по инвариантам I1–I8 (§2.5, §3.9, §4.3) | founder + tech lead |
| G-6 Нагрузка | LT-1..LT-6 пройдены с целями §4; таблица CU §4.2 заполнена фактическими числами | backend |
| G-7 Продукт/право | Решение по SKR (§5), страница раскрытия шансов, ToS/Privacy, dApp Store portal checklist | founder |

---
## 2. Security review

### 2.1 Модель угроз (кратко)

| Актор | Возможности | Цель |
|---|---|---|
| Игрок-читер | Любые tx от своего кошелька, свои программы, подделка аккаунтов, знание кода, доступ к gateway Switchboard | Выбрать исход ролла, бесплатные re-roll'ы, дюп фишек, обход лимитов фаucet'ов |
| Бот-ферма / сибил | Тысячи кошельков, эмуляторы, прокси | Выкачать бесплатные источники, рефералки, Starter, слить в маркет |
| Компрометированный оператор | Ключ `battle_oracle`/`quest_oracle`/`season_oracle`/crank; доступ к API | Назначить победителей, опубликовать корень «себе», вывести бюджеты |
| Внешние зависимости | Switchboard (оракул/gateway), Pyth, Metaplex Core, RPC | Простой, стейл-данные, манипуляция ценой (SKR) |
| Инсайдер с admin/upgrade | Squads-подписи | Изменить odds/fee «под себя», апгрейд с бэкдором |
| MEV / наблюдатель мемпула | Видит tx до включения | Фронтран покупки/листинга, сэндвич по цене |

Границы доверия: **деньги и владение — только on-chain**; сервер доверен только для (а) исхода обычных PvP-матчей (без ставок), (б) агрегатов квестов → Merkle-корни с бюджетом и timelock, (в) исхода wager-матчей через `battle_oracle` с дневным капом и `result_hash`.

### 2.2 Findings

Формат: **ID · Severity · Где · Суть · Последствие · Исправление · Тест**. Критические и высокие — блокеры G-1.

#### SEC-C1 · Critical · `packs.rs:79/250/476`, `fusion.rs:43/316/429`, `arena/lib.rs:188/263` — randomness-аккаунт не проверяется на владельца
> **Статус: исправлено в коде (ожидает компиляции и T-L-C10/F06/A05).** Новый модуль `programs/chip_core/src/randomness.rs`: cfg-константа `SB_PROGRAM_ID` (mainnet `SBond…` по умолчанию, `--features devnet` → `Aio4…`, `--features localnet` → `sb_mock` `ApDh35vcLCxXc5ivaRGFhayn1HduJ9b2nXbfR6WMpVKH`, keypair `tests/localnet/fixtures/sb_mock-keypair.json`) и четыре хелпера, через которые проходят **все** чтения randomness в chip_core и arena: `parse_checked` (owner + layout), `assert_fresh_commit` (`seed_slot == slot−1 && reveal_slot == 0`), `revealed_value` (`seed_slot == commit_slot && reveal_slot > 0`), `assert_refundable` (окно `STALE_PACK_SLOTS` + `reveal_slot == 0`). `buy_pack` и `create_battle` дополнительно несут декларативный `#[account(owner = SB_PROGRAM_ID)]`. Arena больше не зависит от крейта switchboard напрямую — использует `chip_core::randomness` через cpi-зависимость. Юнит-тесты правил — `randomness.rs::tests` (3 теста, cargo test). Фичи объявлены в `chip_core/Cargo.toml` (`devnet = []`, `localnet = []`) и пробрасываются из `arena/Cargo.toml`.

`randomness: UncheckedAccount` парсится через `RandomnessAccountData::parse`, которая проверяет **только 8-байтный дискриминатор `[10,66,229,135,220,239,217,114]` и размер** (см. исходник `switchboard-on-demand 0.13.0/src/on_demand/accounts/randomness.rs`). Ни в одной инструкции нет `owner = <Switchboard program>`.
**Атака:** игрок деплоит программу на 30 строк, создаёт аккаунт с нужным дискриминатором, `seed_slot = slot−1`, `reveal_slot = 0`; вызывает `buy_pack` с ним; затем записывает `reveal_slot = текущий слот`, `value = <байты, дающие Diamond>` и в той же tx вызывает `open_pack`. Ролл полностью контролируется атакующим. Аналогично `fuse` (100 % успех на 50 % рецепте) и `create_battle`.
**Исправление:** cluster-aware константа и constraint во всех шести местах:
```rust
// programs/chip_core/src/economy.rs (и re-export в market/arena)
#[cfg(feature = "localnet")] pub const SB_PROGRAM_ID: Pubkey = pubkey!("<sb_mock id>");
#[cfg(all(feature = "devnet", not(feature = "localnet")))] pub const SB_PROGRAM_ID: Pubkey = pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
#[cfg(not(any(feature = "devnet", feature = "localnet")))] pub const SB_PROGRAM_ID: Pubkey = pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

/// CHECK: Switchboard randomness; owner enforced, layout parsed manually
#[account(owner = SB_PROGRAM_ID @ ChipError::RandomnessMismatch)]
pub randomness: UncheckedAccount<'info>,
```
Cargo: `[features] devnet = ["switchboard-on-demand/devnet"]`, `localnet = []`. Важно: у Switchboard On-Demand **разные program id на mainnet (`SBond…`) и devnet (`Aio4…`)** — см. SEC-H1.
**Тест:** T-L-C10 (fake randomness account → `RandomnessMismatch`), T-L-F06, T-L-A05.

#### SEC-C2 · Critical · `packs.rs:294` + `cancel_stale_pack` constraint `pending.opened == 0` — бандлы (qty ≥ 2) невозможно довскрыть, деньги застревают
> **Статус: исправлено в коде (ожидает компиляции и T-L-C08/C09).** `PendingPack` += `revealed: bool`, `value: [u8; 32]` (аккаунт 126 → **159 байт**; клиентский декодер `accounts.ts` и тест размера обновлены). Первый `open_pack` читает оракул через `randomness::revealed_value` (поле `reveal_slot`, не `get_value(slot)`) и сохраняет значение; паки 2…N берут `pending.value`, оракул больше не читается. `fuse_reveal`/`resolve_battle` — тот же `revealed_value` (settle в любом слоте после reveal). `cancel_stale_pack` дополнительно отвергает `pending.revealed == true`. Клиент `packFlow.open()` при resume берёт значение из `pending.value`, если оно уже зафиксировано.

`open_pack` читает значение через `rnd.get_value(clock.slot)`. В 0.13.0 эта функция возвращает `Ok` **только если `clock.slot == reveal_slot`**, т.е. исключительно в том же слоте, где прошёл `randomness_reveal`. Клиент (`packFlow.ts:190`) корректно кладёт `revealIx` в одну tx с `open_pack` для **первого** пака бандла, но паки 2…N открываются отдельными транзакциями в последующих слотах → всегда `RandomnessNotResolved`. Отмена невозможна (`opened == 1`). Оплата за паки 2…N остаётся в vault под `liab_*` навсегда, burn/treasury-сплит $CG не происходит, `PendingPack` не закрывается.
**Исправление:** зафиксировать значение при первом вскрытии и дальше не трогать randomness-аккаунт:
```rust
// state.rs: PendingPack += pub value: [u8; 32], pub revealed: bool   (space +33; INIT_SPACE пересчитается)
// open_pack:
let base: [u8; 32] = if pending.revealed { pending.value } else {
    let rnd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())?;
    require!(rnd.seed_slot == pending.commit_slot, ChipError::RandomnessExpired);
    require!(rnd.reveal_slot > 0, ChipError::RandomnessNotResolved);   // см. C3: читаем поле, а не get_value(slot)
    pending.value = rnd.value; pending.revealed = true; rnd.value
};
```
Пока значение не зафиксировано, `randomness` остаётся обязательным аккаунтом; после — может передаваться любой (проверка `address = pending.randomness` остаётся).
**Тест:** T-L-C08 (бандл ×5 вскрывается пятью tx в разных слотах), T-L-C09 (×25).

#### SEC-C3 · Critical · `cancel_stale_pack` / `cancel_stale_fusion` (было `STALE_PACK_SLOTS = 300`) — бесплатные re-roll'ы через «подглядывание» в reveal
> **Статус:** часть 1 **выполнена** после решения владельца (Q3): `STALE_PACK_SLOTS = 10_800` в `economy.rs`, `cancel_stale_pack`/`cancel_stale_fusion` требуют `seed_slot == commit_slot && reveal_slot == 0`; клиент `STALE_PACK_SLOTS = 10_800n`; копия «≈ 72 мин» в 7 локалях, docs/02/04, README, лендинге (`check.ts` сверяет число). **Часть 2 выполнена в коде (ожидает `anchor build` + T-L-C17..C20 / T-D-04)** — см. блок «Часть 2 — реализация» ниже. **Часть 3 (crank) выполнена** — `backend/src/crank.ts`, спецификация и статус в §4.3, бэклог #15. Исходное описание сохранено ниже как обоснование.

> **Часть 2 — реализация (программно-владеемые randomness-аккаунты).**
> *Что сделано.* Randomness-аккаунт больше не создаётся клиентским keypair'ом с `authority = buyer`. Теперь это PDA **нашей** программы `["rng", kind u8, owner, nonce u64]` (kind 0 pack / 1 fusion — chip_core; 2 battle — arena), а его Switchboard-`authority` — PDA `["rng_auth"]` той же программы (у chip_core и arena — свои, т.к. подписать за PDA может только программа-владелец). Жизненный цикл:
> 1. `init_randomness(kind, nonce, recent_slot)` (chip_core) / `init_battle_randomness(nonce, recent_slot)` (arena) — CPI `randomness_init` с подписями обоих PDA (`randomness` — signer в IDL, `authority` — signer); игрок только платит ренту (аккаунт 480 B + wSOL reward-escrow ATA + LUT). После CPI программа проверяет `owner == SB_PROGRAM_ID`, `authority == rng_auth`, `seed_slot == 0 && reveal_slot == 0`.
> 2. **Commit — только CPI изнутри платного действия**: `buy_pack` / `fuse` (рандомизированные рецепты) / `create_battle` вызывают `randomness::commit_owned` → проверки **до** CPI (`authority == rng_auth`, `assert_unused`: `seed_slot == 0 && reveal_slot == 0` — один коммит на аккаунт, чужой/повторный аккаунт отвергается), CPI `randomness_commit` (`[randomness rw, queue ro, oracle rw, slot_hashes ro, authority ro signer]`, data = дискриминатор), проверки **после** CPI (`assert_fresh_commit`: `seed_slot == slot − 1 && reveal_slot == 0`). Очередь прибита константой `randomness::SB_QUEUE` per-cluster (mainnet `A43D…`, devnet `EYiA…`) — атакующий не может подставить свою очередь со «своим» оракулом; оракул выбирает клиент (`Queue.selectRandomnessOracle()` — health-снапшоты SDK), членство в очереди проверяет Switchboard.
> 3. `reveal_randomness(signature[64], recovery_id, value[32])` / `reveal_battle_randomness` — **permissionless** CPI `randomness_reveal` с подписью `rng_auth`. Ответ gateway (`fetchRandomnessReveal`) реле́ит кто угодно — crank или игрок; secp256k1-подпись оракула проверяет Switchboard, поэтому подделать значение нельзя, а «не раскрывать» игрок больше не может. Это закрывает открытый вопрос G-0 из п. 2 ниже: в IDL `randomness_reveal.authority` — **signer**, поэтому вариант «reveal делает SDK от имени payer» с PDA-authority не сработал бы; мы всегда идём через CPI. Значение затем читают `open_pack` / `fuse_reveal` / `resolve_battle` через прежний `revealed_value` (C2 не тронут).
> 4. `close_randomness(kind, nonce)` / `close_battle_randomness(nonce)` — permissionless CPI `randomness_close` (рента аккаунта + wSOL-эскроу приходит на `rng_auth` и в той же инструкции переводится игроку — закрывает **SEC-M7** для основной части ренты; `randomness_close_lut` после cooldown LUT — бэклог, метас этой инструкции в доступных копиях IDL нет). Разрешено только когда пиннинг снят: `["pending"|"fusion", owner, nonce]` пуст (`data_is_empty && lamports == 0`), для арены — `battle.status ∈ {Resolved, Cancelled}`.
> *Код.* `programs/chip_core/src/randomness.rs` (константы `RNG_SEED/RNG_AUTH_SEED/RNG_KIND_*`, `SB_QUEUE`, дискриминаторы `SB_IX_RANDOMNESS_{INIT,COMMIT,REVEAL,CLOSE}` = `sha256("global:<name>")[..8]` — тест `discriminators_match_anchor_convention`; хелперы `assert_authority`, `assert_unused`, `init_owned`, `commit_owned`, `reveal_owned`, `close_owned` с метас в порядке IDL `sb_on_demand`), `instructions/rng.rs` (3 инструкции chip_core), `arena/src/lib.rs` (3 инструкции арены + `CreateBattle`), `errors.rs` (+`RandomnessAuthority`, `RandomnessUsed`). Клиент: `chain/ix/rng.ts` (билдеры init/reveal/close + `commitAccountMetas`), `chain/switchboard.ts` (без keypair'ов: `prepareRandomness(kind, nonce)` → `[init]`, `prepareReveal` заворачивает payload SDK в наш `reveal_randomness`, `prepareClose`), `pdas.ts` (`rngPda`, `rngAuthPda`, `sbStatePda`, `sbLutSignerPda`, `sbLutPda`, `sbOracleStatsPda`, `sbRewardEscrow`), обновлённые `buyPackIx` (16 аккаунтов), `fuseIx` (19, пять `Option`-слотов для атомарных рецептов), `createBattleIx` (15), флоу pack/fusion/arena + кнопка «Reclaim rent»; `sync-check` сверяет таблицы program-id/queue rust ↔ client ↔ backend; `chain.test.ts` +5 тестов (43 зелёных).
> *Экономика транзакции покупки.* Одна подпись игрока: `init_randomness` + `buy_pack` (commit внутри) — как и раньше две инструкции, но обе наши; CU ≈ +15–25 k на CPI-обёртки (лимит клиента поднят 400 k → 500 k). Рента, замороженная у игрока на время реквеста, не изменилась (≈ 0.006–0.008 SOL), но теперь возвращается `close_randomness` (кнопка в UI или crank).
> *Остаточные риски / что проверить на devnet (T-D-04, до mainnet).* (а) Метас `randomness_init/commit/reveal/close` взяты из 7 сторонних копий IDL `sb_on_demand` (все совпадают; свежайшая 2026-03) и крейта 0.13.0 (`RandomnessCommit::invoke` — 1:1 с нашим `commit_owned`); официальный IDL Switchboard в репозитории не публикует — при `anchor idl fetch SBond…` сверить ещё раз. Косвенное подтверждение поддержки схемы «randomness-аккаунт = PDA программы-владельца»: doc-комментарий SDK 3.10.6 к `Randomness.closeLutIx` — *«The transaction must be signed by the randomness keypair, **or CPI-invoked by the program that controls the randomness PDA**»*. (б) `randomness_init` внутри CPI: Switchboard создаёт `randomness` через system program с подписью нашего PDA — стандартно для `init` с PDA-signer, но размер/владелец аккаунта должны совпасть с `RandomnessAccountData::size()` (480) — проверяется `parse_checked` сразу после CPI. (в) `randomness_reveal` может оплачивать reward оракулу из `payer` (в метас `payer` — signer + writable): бюджет crank-кошелька закладываем ≈ 0.0005 SOL/reveal до измерения (T-D-03). (г) Fallback, если что-то из (а)–(в) не подтвердится: оставить `authority = buyer`, но сохранить `assert_unused` + пиннинг (защита от повторного коммита остаётся, защита от «не раскрывать» — только crank + часть 1).

Значение reveal получается **off-chain** запросом к gateway оракула (`gateway.fetchRandomnessReveal`, см. SDK `revealIx`) через несколько секунд после коммита — без отправки чего-либо on-chain. Игрок: `buy_pack` → узнаёт ролл → если плохой, ждёт 300 слотов (~2 мин) и вызывает `cancel_stale_pack` → **100 % возврат** (проверка `get_value(clock.slot).is_err()` почти всегда истинна, см. C2) → повторяет до Diamond. Стоимость попытки — комиссии и временная рента. То же для рискованных fusion-рецептов (fee уже сожжён, но материалы возвращаются — выбор «провал → отмена»).
Принцип (из документации Switchboard): «take collateral at commit» работает только если **нет пути возврата, пока значение получаемо**. Запрос оракула истекает через **1 час** после коммита; до этого reveal доступен любому.
**Исправление (архитектурное, три части):**
1. **Refund только после истечения запроса и только если reveal не состоялся:** `STALE_PACK_SLOTS` → `STALE_SLOTS = 10_800` (≈ 72 мин при 400 мс; окно 1 ч + запас) и условие `rnd.reveal_slot == 0 && rnd.seed_slot == pending.commit_slot` вместо `get_value(...).is_err()`. После истечения оракул не подписывает reveal, значит никто (включая владельца) больше не узнает значение → возврат безопасен.
2. **Владелец не должен контролировать randomness-аккаунт.** Сейчас `authority = buyer` (`Randomness.create(program, kp, queue, payer)`): buyer может (а) не отправлять reveal и (б) потенциально повторно `randomness_commit` (authority — signer коммита), сдвинув `seed_slot`. Сделать authority = PDA `["rng_auth"]` программы chip_core (arena — своя), коммит выполнять **CPI из `buy_pack`/`fuse`/`create_battle`** (`switchboard_on_demand::RandomnessCommit::invoke_signed`, есть в 0.13.0), а init-инструкцию строить на клиенте вручную с `authority = PDA` (`program.instruction.randomnessInit(...)`). **Открытый вопрос G-0:** требует ли `randomness_reveal` подписи authority (в IDL `SBond…` проверить `isSigner`). Если да — `open_pack`/`fuse_reveal`/`resolve_battle` принимают `(signature[64], recovery_id, value[32])` и делают CPI reveal с PDA-подписью перед чтением; если нет — reveal остаётся permissionless и его делает crank.
3. **Crank обязан вскрывать чужие паки.** Backend-воркер (сейчас отсутствует — см. SEC-I2) в течение секунд после `PackBought` получает reveal и отправляет `reveal + open_pack` за счёт резерва ренты. Тогда игрок физически не успевает «выбрать»: его пак вскроют независимо от желания. UI: до истечения окна кнопки «вернуть деньги» нет вообще; показываем «оракул отвечает… / crank вскрывает…».
Побочные правки (сделаны): копия «300 slots / ≈ 2 мин» → «10 800 slots / ≈ 72 мин» в `client/src/chain/ix/chipCore.ts`, `packFlow.ts`, `locales/*.ts` (`oneSignature`, 7 языков), `docs/02:130`, `docs/04:161/208`, `programs/README.md`, `scripts/landing/content.py` (`rules.5`, FAQ), `check.ts`.
**Тест:** T-L-C11 (cancel до истечения → `NotStale`), T-L-C12 (после reveal cancel невозможен, open возможен в любом слоте), T-L-C13 (после истечения без reveal — refund, инварианты vault/liab), T-L-F07, T-L-A06.

#### SEC-H1 · High · `client/src/chain/ids.ts:21–22`, `Anchor.toml`, все программы — неверный program id Switchboard для devnet и несогласованный localnet
> **Статус: исправлено.** Клиент: `SWITCHBOARD_PROGRAM_ID[cluster]` (`mainnet-beta: SBond…`, `devnet: Aio4…`, `localnet: ApDh35…` = sb_mock), `SWITCHBOARD_ON_DEMAND_ID` теперь производная от `CLUSTER`; тест T-U-ids в `chain.test.ts`. Программы: features из SEC-C1. `Anchor.toml`: закомментированный `[[test.genesis]]` заполнен реальным id sb_mock (включить после написания `programs/sb_mock`, бэклог #14).

Комментарий «same program id on devnet + mainnet since v0.13» неверен: SDK 3.10.6 (`utils/index.js`) и крейт 0.13.0 (`program_id.rs`) содержат `ON_DEMAND_DEVNET_PID = Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2`, mainnet — `SBond…`. Клиент грузит программу по `SWITCHBOARD_ON_DEMAND_ID` (`SBond…`) на devnet → все commit/reveal флоу на devnet падают. `Anchor.toml` клонирует `SBond…` с mainnet, а клиент на localnet использует **devnet-очередь** `EYiA…` (существует только под `Aio4…` на devnet) → localnet не поднимется в принципе; кроме того на localnet нет оракула, который подпишет reveal.
**Исправление:** (1) клиент — `SWITCHBOARD_PROGRAM[cluster]` (`mainnet-beta: SBond…`, `devnet: Aio4…`, `localnet: <sb_mock>`), либо не передавать programId и дать `AnchorUtils.loadProgramFromProvider` выбрать по genesis hash; (2) программы — features из SEC-C1; (3) localnet — собственный **mock-программа `sb_mock`** (см. §3.5) вместо клонирования; devnet — реальный `Aio4…` + очередь `EYiA…`.
**Тест:** T-U-ids (таблица id по кластерам), T-L-* (вся localnet-сюита на моке), T-D-01 (devnet smoke).

#### SEC-H2 · High (operational) · `admin.rs::set_paused`, `staking::set_paused`, `arena::set_arena` — экстренная пауза заперта за 48-часовым timelock — **исправлено (бэклог #4, ожидает `anchor build`)**
Пауза подписывается тем же Squads-vault'ом (3/5 + 48 ч timelock для chip_core/staking), что и `set_params`/upgrade. Реакция на любой инцидент из этого раздела занимает ≥ 48 ч. При этом `paused` уже правильно не блокирует `cancel_*`, `unstake_*`, `claim_*` (см. таблицу §2.4).
**Исправление:** отдельное поле `pauser: Pubkey` в `GameConfig`/`EmissionState`/`ArenaConfig` (горячий Squads 1/3 без timelock, право только на `set_paused(true)`; снятие паузы — только admin), либо Squads-роль с ограниченной инструкцией. Runbook: пауза ≤ 10 мин от алерта.
**Статус:** во всех трёх программах добавлены `set_pauser(pauser)` (admin; `Pubkey::default()` = снять) и `pause()` (подписант = pauser **или** admin; пишет только `paused = true`, идемпотентна) — у pauser'а физически нет инструкции, которая пишет `false`, снятие паузы остаётся за `set_paused(false)` / `set_arena(paused: Some(false))` под `has_one = admin`. Поле `pauser` дописано **в конец** структур (декодеры клиента читают его; бэкенд-декодер `GameConfig` останавливается на старых полях и не ломается). Событие `PauseChanged{by, paused}` во всех трёх программах → индексатор пишет `pause_changes` (кто/когда/какую программу), `GET /health.paused` отдаёт последнее состояние на программу. Prisma: `PauseChange`. Runbook: pauser = Squads 1/3 на «горячих» ключах дежурных (телефоны Seeker), цель ≤ 10 мин от алерта; после инцидента admin снимает паузу отдельной транзакцией через обычный timelock-путь **или** заранее подготовленной «unpause»-транзакцией Squads с истёкшим timelock'ом (готовится при каждом деплое).
**Тест:** T-L-G03b (`tests/localnet/00-admin.spec.ts`): для chip_core / staking / arena — до назначения pauser не может; stranger не может назначить; pauser ставит паузу (дважды — идемпотентно), не может снять и не может `set_params`; `buy_pack` под паузой → `Paused`; admin снимает и сам умеет `pause`; снятый pauser теряет право. T-B: `backend/test/projections.test.ts` «SEC-H2 pause audit».

#### SEC-H3 · High · `backend/src/server.ts` — нет rate-limiting — **исправлено (бэклог #5)**
`POST /auth/siws/nonce` создаёт строку в БД на каждый вызов без лимита; `/packs/quote` (после реализации) дергает Pyth/RPC; `/market/*` — тяжёлые выборки. Одного скрипта достаточно для деградации API (цель 99.9 %).
**Исправление:** `express-rate-limit` + Redis store: nonce 10/мин/IP и 30/ч/кошелёк; чтение 600/мин/IP; мутации 60/мин/сессия; `429` + `Retry-After`; Turnstile на `/quests/claims` и `/services/claim`; ограничение размера тела 16 KB. Nonce-таблица — TTL-очистка уже есть (`auth.ts:21`), добавить cap строк на кошелёк = 3.
**Статус:** реализовано собственным middleware `backend/src/ratelimit.ts` (без зависимости; `RateLimitStore` — интерфейс, in-memory реализация сейчас, Redis `INCR/PEXPIRE` по тем же ключам при переходе на Postgres/Redis): политики в точности из таблицы выше + verify 20/мин/IP, quote 30/мин/сессия, claim/handle 10/мин/сессия; IPv6 считается по /64; заголовки `RateLimit-Policy/Limit/Remaining/Reset` (draft-7) и `Retry-After`; тело ≤ 16 KB → 413; cap 3 nonce/кошелёк. Turnstile отложен до реализации `/quests/claims` (501).
**Тест:** T-B-40 (превышение → 429) — `backend/test/security.test.ts` ✅, LT-1 (профиль злоупотребления).

#### SEC-M1 · Medium (economy) · `staking::report_burn` никем не вызывается — **исправлено (бэклог #6, ожидает `anchor build`)**
`ReportBurn` принимает только PDA `["burn_reporter"]` программ chip_core/market/arena, но ни одна из них не делает CPI (в chip_core только `emit!(BurnReported)`, в arena аккаунт объявлен «optional in v1»). `trailing_burn_avg() == 0` → `guarded_daily = cap × 30 %` навсегда: эмиссия застрянет на полу, стейкинг/квесты/сезон получат 30 % от модели `docs/02 §7.3`.
**Исправление (v1, без роста CU в горячих путях):** oracle-фид — индексатор считает дневной burn по событиям `BurnReported`/`ChipSold`/`BattleResolved`, `burn_oracle` (ключ из `set_oracles`) вызывает `report_burn` раз в час; on-chain ограничение: `burn_today ≤ 3 × cap` (санити) и уже существующий `burnMultiple 1.25 / cap`. v2 — прямые CPI из `open_pack` (последний пак) и `fuse`.
**Статус:** `EmissionState.burn_oracle` (в конце структуры, после `pauser`), `OraclePatch.burn_oracle: Option<Pubkey>` в `set_oracles` (`Some(default())` снимает), `report_burn` принимает PDA-репортёров **или** `burn_oracle`; `burn_today = min(burn_today + amount, 3 × daily_schedule_cap)` (`BURN_SANITY_MULT`). Оракул может только поднять guard с пола 30 % к 100 % расписания — минтить сам не может, выше расписания не может, admin снимает ключ одной транзакцией. Бэкенд: `backend/src/burn-oracle.ts` (`npm run backend:burn-oracle`, ключ `BURN_ORACLE_KEYPAIR`, интервал `BURN_ORACLE_INTERVAL_MS` 1 ч): сумма таблицы `burns` с курсора по rowid `events_raw` → `report_burn(delta)` → курсор двигается **после** подтверждения (сбой между отправкой и записью повторяет максимум один интервал, on-chain clamp ограничивает ущерб); < 1 $CG переносится, > 5 M $CG за раз — отказ + ALERT (баг индексатора, не транзакция). В `burns` теперь пишутся и комиссия листинга (0.5 $CG на `ChipListed`), и `BattleResolved.rake_burn` — раньше `/stats.burnedCgMicro` их не видел; строки `staking` (early-exit) исключаются — они уже учтены `record_internal_burn`. `GET /health.burnOracle` (последний репорт, возраст, ожидающая сумма, `healthy`). `scripts/setup.ts --step burn-oracle` с `BURN_ORACLE=<pubkey>`.
**Тест:** T-L-S05 (wallet → `NotBurnReporter`; после `set_oracles` оракул репортит, `burn_today` растёт ровно на сумму; 10 × cap → clamp 3 × cap; `default()` снимает роль; `tick_day` → guard ≈ 0.84 × cap > пола 30 %); T-B `backend/test/burn-oracle.test.ts` (6 тестов: раскладка инструкции, агрегат = chip_core + market + arena без staking, дельта/курсор/повтор, откат при ошибке программы, dust/absurd, `/health`).

#### SEC-M2 · Medium · Pyth — нет проверки доверительного интервала, SKR-фид тонкий — **исправлено (бэклог #7, ожидает `anchor build`)**
`get_price_no_older_than(&clock, 60, feed)` проверяет id, возраст и уровень верификации, но не `conf`. Для SOL это ±0.5 % в норме, но в момент волатильности `conf` растёт до нескольких процентов; для SKR (ликвидность ≈ $1.5 M) ещё и манипулируем через Meteora-пул.
**Исправление:** `require!(p.conf.saturating_mul(100) <= (p.price as u64).saturating_mul(2))` (≤ 2 %), для платежей брать `price − conf` (цена в пользу протокола); для SKR — EMA (`get_ema_price_no_older_than`) + cap скидки 15 % (уже) + дневной лимит SKR-оборота в `GameConfig` до решения по §5.
**Тест:** T-R-03 (wide conf → `StalePrice`), T-P-06 (`units_for_cents` монотонность/переполнение при expo −12…−6, price до 1e12).
**Статус (после Q7):** возрастной риск снят на уровне ops — свой pusher держит цену ≤ 45 с (алерт > 45 с, критический > 60 с), API отказывает в котировке при < 15 с остатка (`503 price_unavailable`, T-B-39 ✅).
**Статус conf-guard:** `chip_core::instructions::packs::oracle_price(pu, clock, feed)` — единая точка чтения цены для `buy_pack` и `pay_service` (SOL и SKR): возраст/фид/уровень верификации как раньше, затем `conf × 10 000 ≤ price × PYTH_MAX_CONF_BPS (200)` иначе новая ошибка `PriceUncertain`, и цена к оплате = **`price − conf`** (край интервала в пользу протокола; при нормальных 0.05 % это +0.05 % к сумме — внутри 1 % slippage-guard котировки). Зеркала бит-в-бит: `packages/economy` `effectivePythPrice` / `PYTH_MAX_CONF_BPS` (sync-check), бэкенд `validateSnapshot` → `price_uncertain` → `503 price_unavailable`, `quoteUnits` по `price − conf`; клиент `usdCentsToUnits` / `isConfident`. EMA для SKR отложена: при своём pusher'е `conf` уже отражает разброс публикаторов, а `price − conf` + cap скидки 15 % + slippage 1 % закрывают манипуляцию тонким пулом дешевле, чем второй путь чтения; дневной лимит SKR-оборота — §5 (открыт).
**Тест:** T-L-C02 (conf 2 % + 1 → `PriceUncertain`; ровно 2 % → принято и списано по `price − conf`; обычная покупка = `units_for_cents(price − conf)`), T-L-C03 (SKR по `price − conf`), T-B quote «SEC-M2» (503 при 2.5 %, граница 2 %, сумма 33 283 308 при 0.05 %), economy test (`effectivePythPrice`), client chain.test (`isConfident`).

#### SEC-M3 · Medium · `fusion.rs:211` — fee сжигается на коммите, при `cancel_stale_fusion` не возвращается
Для рецепта 7 это 6 000 $CG. При простое оракула (даже после исправления C3) игрок теряет fee без результата.
**Исправление:** эскроу fee в PDA-ATA `["fusion_fee", pending]` при `fuse`, burn при `fuse_reveal`, возврат при `cancel_stale_fusion`. Дополнительно +1 аккаунт, ~6 k CU.
**Тест:** T-L-F08.

#### SEC-M4 · Medium · backend `auth.ts:46` / `server.ts:38` — SIWS-домен берётся из `x-forwarded-host` — **исправлено (бэклог #5)**
Если прокси не перезаписывает заголовок, клиент подставит любой домен, и проверка домена теряет смысл (фишинговая подпись с другого сайта переиспользуется). `issuedAt` не проверяется на разброс.
**Исправление:** `SIWS_DOMAIN` из конфигурации (allowlist), `|now − issuedAt| ≤ 5 мин`, `CORS_ORIGINS` в проде — явный список (сейчас по умолчанию `*`), `COOKIE_SECURE=1` обязателен при `NODE_ENV=production` (fail-fast).
**Статус:** `SIWS_DOMAINS` (список хостов; по умолчанию выводится из `CORS_ORIGINS`, при `*` в dev проверка выключена), `Issued At` обязателен и `|now − issuedAt| ≤ SIWS_MAX_DRIFT_S` (300), `assertProductionConfig()` в `createApp` при `NODE_ENV=production` падает без явного `CORS_ORIGINS`, `COOKIE_SECURE=1`, `SESSION_SECRET ≥ 32 символов`, домена. Клиент (`client/src/app/session.tsx`) уже подписывает `window.location.host` + `Issued At` → изменений на клиенте нет.
**Тест:** T-B-41..43 — `backend/test/security.test.ts` ✅.

#### SEC-M5 · Medium · индексатор работает на `confirmed`
`ingest.ts:97` / `config.ts:36` — проекции применяются при `confirmed`. Форк/дроп tx (редко, но бывает) оставит призрачную фишку/сделку/прогресс квеста. Для UI это правильно, для денег — нет.
**Исправление:** колонка `finalized_at`; квесты, хэндлы, рефералы, лидерборд учитывают только финализированные события; фоновая задача сверяет `confirmed`-события старше 150 слотов через `getSignatureStatuses` и откатывает отсутствующие (`rebuild` уже детерминирован — T-B-15).
**Тест:** T-B-44 (симуляция дропа → проекция откатывается).

#### SEC-M6 · Medium (revenue) · роялти `Royalties` на внешних площадках — **уже реализовано, закрыто**
Повторная проверка кода: `admin.rs::create_collection` (:107–126) уже ставит `Plugin::Royalties { basis_points: ROYALTY_BPS = 250, creators: [treasury 100 %], rule_set: RuleSet::None }` на уровне Core-коллекции (наследуется всеми ассетами; `market::ROYALTY_BPS = 250` дублирует расчёт внутри нашего маркета и проверяется `sync-check`). Первоначальная формулировка находки была ошибочной (смотрели только плагины ассета в `packs.rs`). Владелец подтвердил 2.5 % (Q4 §5). Остаточный принятый риск: fee 7.5 % внешние площадки не удержат — ликвидность важнее.
**Тест:** T-L-G01 (плагин присутствует в коллекции, `basis_points == 250`, creator = treasury).

#### SEC-M7 · Medium (unit economics) · рента Switchboard-аккаунтов не возвращается
`randomness_init` создаёт randomness-аккаунт (~408 B), wSOL reward-escrow ATA и **Address Lookup Table** (`lut`, `lutSigner` в аккаунтах init) — суммарно ≈ 0.006–0.008 SOL на покупку, замороженных у игрока, пока он не вызовет `randomness_close` + `randomness_close_lut` (после cooldown). В клиенте `closeIx` не используется. При $1.49–4.99 паках это заметная доля чека и источник тикетов «куда делись 0.007 SOL».
**Исправление:** после `PackOpened` клиент предлагает «вернуть ренту» (одна tx: `randomnessClose`; LUT — отдельной tx после cooldown, можно батчить crank'ом, если authority = PDA — программа возвращает ренту покупателю). Отразить в экономике (`docs/02 §2`) и в тексте квоты.
**Статус (после C3 части 2):** основная часть **сделана в коде** — `close_randomness` / `close_battle_randomness` (CPI `randomness_close` от PDA `rng_auth`, рента аккаунта + wSOL-эскроу → игроку в той же инструкции), кнопка «Reclaim rent» в `PackStepper`/`Opening`, авто-вызов после fusion; crank добьёт остальное (часть 3). Открыто: `randomness_close_lut` (рента LUT ≈ 0.0015 SOL, cooldown ~ 1 эпоха) — бэклог #23.
**Тест:** T-D-03 (измерить фактическую ренту и стоимость reveal на devnet), T-E-03b, T-L-C20 (close до закрытия pending → `InvalidChipState`; после → баланс игрока +рента).

#### SEC-L1 · Low · `chip.rs::set_chip_flag` — семантика `expected_owner`
Флаг ставится по подписи PDA `market_auth`/`stake_auth` соответствующей программы (hard-coded id `chip.rs:20–22`) и проверке `BaseAssetV1.owner == expected_owner`; `is_free` требует отсутствие других флагов и `now ≥ lock_until`. Корректно; риск — рассинхрон id после `anchor keys sync` (см. G-0). **Действие:** unit-тест, что `MARKET_PROGRAM_ID == market::ID` и т.д. (T-R-24).

#### SEC-L2 · Low · арена не замораживает фишки на время боя
Между `accept_battle` и `resolve_battle` фишки можно продать/застейкать; выплата считается по снимку `squad_a/b`+`power`, поэтому денежного эффекта нет. Принято; отметить в UI («состав зафиксирован»).

#### SEC-L3 · Low · `RENT_RESERVE_PER_CHIP = 0.006 SOL` близко к фактической ренте
Core-ассет с 4 плагинами + `ChipState` ≈ 0.005–0.006 SOL; при превышении разницу платит crank. Измерить на devnet (T-D-03), заложить 0.008 и вернуть остаток (уже возвращается при закрытии).

#### SEC-L4 · Low (product) · listing fee 0.5 $CG требует $CG у продавца
Новый игрок без $CG не может выставить фишку. Вариант: fee в SOL-эквиваленте (0.0005 SOL) или первые 3 листинга бесплатно (счётчик в `PlayerItems`).

#### SEC-I1 · Info · `overflow-checks = true` в `[profile.release]` корневого `Cargo.toml`
Покрывает «голые» `-=` на `liab_*` (`packs.rs:516,428`) — переполнение = паника = откат tx. Оставить; в тестах добавить кейс двойного списания (T-R-08).

#### SEC-I2 · Info · crank-воркеров в бэкенде нет
> **Статус: исправлено.** `backend/src/crank.ts` (`npm run backend:crank`, отдельный процесс с горячим ключом `CRANK_KEYPAIR`): reveal через gateway оракула → `open_pack` / `fuse_reveal` / `reveal_battle_randomness` → `close_randomness` (рента игроку). Спецификация и реализация — §4.3; тесты `backend/test/crank.test.ts` (24 сценария на фейковой цепочке и фейковом gateway). Не входят в crank и остаются на клиенте/оракуле: `resolve_battle` (подпись `battle_oracle` арена-сервера — 501-заглушка), `thaw_chip`/`tick_day` (вызываются игроком/админом по необходимости, SLA нет).

`backend/src` не содержал `open_pack`/`fuse_reveal`/`tick_day`/`thaw` крэнков; единственный «crank» — клиент игрока. Для C3 и для SLA «pending ≤ 20 с» crank обязателен. Спецификация — §4.3.

#### SEC-I3 · Info · Permanent-делегаты Metaplex Core
`PermanentTransferDelegate/PermanentBurnDelegate` под `UpdateAuthority` (= PDA коллекции) дают программе право переместить/сжечь любую фишку. Используется только в `deliver_sold`/`fuse`; upgrade authority программы = Squads 3/5 + 48 ч. Раскрыть в FAQ/ToS («программа, а не команда»).

### 2.3 Чеклист по инструкциям (что проверено статически)

Легенда: ✔ есть · ✘ нет · — н/п. Колонки: подпись/авторизация; владение ассетом; PDA seeds+bump; арифметика (`checked_*`/`saturating`); CEI (состояние до CPI); пауза; закрытие/рента; remaining_accounts валидированы.

**chip_core**

| Инструкция | Auth | Owner | PDA | Arith | CEI | Pause | Close/Rent | rem_accs | Замечания |
|---|---|---|---|---|---|---|---|---|---|
| `initialize` | admin signer | — | ✔ | — | — | — | — | — | однократно (init) |
| `create_collection` | admin | — | ✔ | ✔ | ✔ | — | — | — | idx последовательный, element < 5, symbol ≤ 16 |
| `set_params` | admin | — | ✔ | ✔ | — | — | — | — | Σ odds = 10 000; Common ≥ 5 %; top2 ≤ cap; price 50…50 000 ¢; pity ≥ 10; fee ≤ 10 %; featured < created |
| `set_paused` / `set_pauser` | admin | — | ✔ | — | — | — | — | — | **H2** закрыт: `pause` — pauser или admin, только `true`; `PauseChanged` |
| `pause` | pauser ∨ admin | — | ✔ | — | — | — | — | — | идемпотентна; без timelock (Squads 1/3) |
| `propose_admin`/`accept_admin` | admin / new | — | ✔ | — | — | — | — | — | двухшаговая передача ✔ |
| `sweep_vault` | admin, `has_one treasury` | — | ✔ | ✔ | — | — | — | — | никогда ниже `liab_*` + rent ✔ |
| `grant_booster` | `rewarder` PDA staking / admin | — | ✔ | ✔ | — | — | — | — | |
| `buy_pack` | buyer | — | ✔ | ✔ | ✔ | ✔ | init PendingPack + резерв | — | **C1**, **C3(2)**; Pyth 60 с; slippage; SKR −5 %; qty 1..25 |
| `open_pack` | anyone (payer) | — | ✔ | ✔ | ✔ | ✔ (нет — верно: crank должен работать в паузе? см. §2.4) | close на последнем; возврат crank ≤ reserve | ✔ (4×N, PDA re-derive, collection re-check) | **C1**, **C2**; config `mut` в каждом вызове (см. §4.2) |
| `cancel_stale_pack` | buyer | — | ✔ | ✔ (overflow-checks) | ✔ | не блокируется ✔ | close → buyer | — | **C3** |
| `pay_service` | payer | ✔ для CapSkin (backend) | ✔ | ✔ | ✔ | ✔ | — | — | ref_hash; дневные капы по kind |
| `fuse` | owner | ✔ `BaseAssetV1.owner` ×3 | ✔ | ✔ | ✔ | ✔ | init PendingFusion для рискованных | ✔ ×3(+3) с дубликатами | **C1**, **M3**; same-collection на чётных |
| `fuse_reveal` | anyone | — | ✔ | ✔ | ✔ | — | close → payer | ✔ | **C1**; провал → burn 2, возврат 1 |
| `cancel_stale_fusion` | owner | — | ✔ | — | ✔ | не блокируется ✔ | close → owner | ✔ | **C3**, **M3** |
| `set_chip_flag` | PDA market/staking | ✔ `expected_owner` | ✔ | — | ✔ | — | — | — | **L1** |
| `deliver_sold` | PDA market | ✔ seller | ✔ | — | ✔ | — | — | — | требует `F_LISTED` |
| `thaw_chip` | owner | ✔ | ✔ | — | ✔ | — | — | — | только после `lock_until` |
| `level_up` | PDA staking `rewarder` | — | ✔ | ✔ | ✔ | — | — | — | maxLevel по редкости |

**market** — `list/update_price/cancel/buy/make_offer/cancel_offer/accept_offer`: подпись seller/buyer/bidder ✔; владение через `BaseAssetV1.owner` ✔; `F_LISTED` через CPI ✔; `buy`: `expected_price`+`currency` guard ✔, `SelfTrade` ✔, `split()` sums-to-price (unit-тест) ✔, fee ≤ `MAX_MARKET_FEE_BPS` ✔; офферы: USDC-эскроу, TTL ≤ max, `OfferExpired` ✔, `accept_offer` проверяет `F_LISTED == 0`, `lock_until`, `F_SOULBOUND` ✔; пауза — читает `GameConfig.paused`? **✘ нет** (маркет не имеет своего `paused`; допустимо — торги в паузе не создают эмиссии, но добавить чтение `config.paused` для `list/buy` — L). Роялти — **M6**.

**arena** — `init_arena/set_arena` admin ✔; `create_battle`: randomness **C1/C3**, `MIN_WAGER..MAX_WAGER`, squad ×3 (owner, не `F_LISTED|F_FUSING`, дубликаты) ✔, эскроу ATA под PDA battle ✔; `accept_battle`: `SelfBattle`, `ACCEPT_TIMEOUT`, `LeagueMismatch` ✔; `resolve_battle`: oracle signer ✔, winner ∈ {A,B} ✔, `winner_cg.owner == winner` ✔, rake 5 % = 40/20/rest-burn ✔, дневной cap по pot ✔, `get_value(clock.slot)` → reveal должен быть в той же tx (ок для оракула, **зависит от вопроса authority в C3(2)**), rent эскроу → oracle (компенсация fee) ✔; `cancel_stale_battle`: роли/таймауты ✔, возврат обоим ✔, `Cancelled` ✔. Пауза блокирует `create/accept`, не блокирует `cancel` ✔. Chips не морозятся — **L2**.

**staking** — `init_emission/set_split (Δ ≤ 1 000 bps)/set_paused/set_pauser/set_oracles` admin ✔, `pause` pauser ∨ admin (**H2**) ✔; `tick_day` anyone, раз в сутки, guarded budget, неистраченное не переносится ✔ (**M1** закрыт — burn-фид от оракула); `report_burn` только `burn_reporter` PDA или `burn_oracle`, clamp 3 × cap ✔ (**M1**); `publish_root` oracle из списка, бюджет ≤ slice, резервируется ✔; `revoke_root` возвращает бюджет ✔; `claim_root`: timelock 1 ч ✔, proof ≤ 24 ✔, leaf/node домен-разделение 0x00/0x01 ✔, receipt PDA `["claim", root, wallet]` (init → нет повтора) ✔, mint через PDA ✔; `stake_cg/unstake_cg`: тиры, penalty из principal ✔ (сжигается → `record_internal_burn` ✔); `stake_chip/unstake_chip`: CPI `set_chip_flag(F_STAKED)` с `expected_owner` ✔, веса по редкости ✔; `sync_set_bonus`: `sets ≤ 10` ✔, set-oracle. Пауза блокирует `stake_*`, `tick_day`, `publish_root`, `claim_root`; **не блокирует `unstake_*`** ✔ (проверено: `UnstakeCg/UnstakeChip` без constraint).

### 2.4 Семантика паузы (сводно)

| Программа | Блокируется при `paused` | Всегда доступно |
|---|---|---|
| chip_core | `buy_pack`, `fuse`, `pay_service` | `open_pack` (crank добивает начатое), `fuse_reveal`, `cancel_stale_*`, `thaw_chip`, admin |
| market | — (нет флага; L) | всё |
| arena | `create_battle`, `accept_battle` | `resolve_battle`, `cancel_stale_battle` |
| staking | `stake_cg`, `stake_chip`, `claim_chip`, `tick_day`, `publish_root`, `claim_root` | `unstake_cg`, `unstake_chip`, `revoke_root`, `report_burn` |

Правило: пауза никогда не запирает средства пользователя (возвраты/анстейк/отмены работают). ✔ по коду.

### 2.5 Ключи, роли, операционная безопасность

| Роль | Носитель | Права | Ограничители |
|---|---|---|---|
| Upgrade authority chip_core/staking | Squads 3/5 + 48 ч timelock | деплой | публичный анонс, verifiable build (`solana-verify`), после стабилизации — рассмотреть immutable |
| Upgrade authority market/arena | Squads 2/5 | деплой | те же |
| `admin` (config/emission/arena) | те же Squads | `set_params`, `set_split`, `set_oracles`, `sweep_vault`, `create_collection` | on-chain guard-rails §2.3; журнал `ParamsChanged` |
| `pauser` (**H2**, реализовано) | Squads 1/3 горячий (дежурные, Seeker) | `pause()` в chip_core / staking / arena | только `paused = true`; снять паузу может только admin (`set_paused(false)` / `set_arena`); назначение/снятие роли — `set_pauser` от admin; каждая смена — событие `PauseChanged` в аудит-логе |
| Казначейский SKR-кошелёк `HPMr…htho` (владелец, 2026-09-15) | **single-signer (on-curve), не Squads** | получатель `sweep_vault` по SKR, подписант `fund_skr` | до запуска: аппаратный подписант (Ledger); когда в кошельке > 1 недели выручки — перевести в Squads 2/3 и заменить `SKR_TREASURY_WALLET` + `GameConfig.treasury` (`set_params`, без редеплоя). Публичный леджер `GET /rewards/skr-pool.funding` показывает `dueMicro`/`surplusMicro` — отставание от политики видно всем |
| `battle_oracle` | HSM/KMS-подписант в изолированном сервисе | `resolve_battle` | дневной cap; `result_hash`; ротация раз в 30 д; алерт при > 3 резолвов/мин с одним winner |
| `quest_oracle` / `season_oracle` | то же | `publish_root` | бюджет слайса; timelock 1 ч; `revoke_root`; double-sign (две подписи от независимых сервисов на один корень — v1.1) |
| `burn_oracle` (**M1**, реализовано) | горячий ключ бэкенд-keeper'а (`BURN_ORACLE_KEYPAIR`; баланс ≤ 0.5 SOL — платит только комиссии) | `report_burn` раз в час | on-chain clamp `burn_today ≤ 3 × daily cap`; off-chain отказ > 5 M $CG за репорт; может только поднять guard к 100 % расписания, минт не контролирует; `set_oracles(burn_oracle = default)` снимает; алерт `/health.burnOracle.healthy == false` |
| Payer Pyth-pusher'а (**Q7**) | горячий кошелёк `ops/pyth-pusher/payer.json`, только SOL, баланс ≤ 6 SOL (≈ 3 мес) | подпись `update_price_feed` в наш shard 0xCA75 (permissionless-инструкция) | компрометация даёт лишь трату SOL payer'а — PDA от payer'а не зависят; алерты `PythPusherWalletLow/Critical`; ротация = новый keypair + рестарт |
| crank-ключи | обычные горячие кошельки с лимитом баланса ≤ 2 SOL | `open_pack`, `fuse_reveal`, `tick_day`, `thaw` | permissionless инструкции — компрометация даёт только потерю баланса ключа |
| API `SESSION_SECRET` | секрет-менеджер | подпись cookie | ротация с grace 24 ч |

Процедуры: инцидент-runbook (пауза ≤ 10 мин → диагностика → патч через timelock или revoke roots), bug-bounty (Immunefi-стиль, до 10 % от риска, cap $50 k), мониторинг инвариантов I1–I7 каждые 60 с с алертом, ежедневный отчёт «эмиссия vs cap / burn / vault vs liab».

### 2.6 Бэкенд и клиент — чеклист

**Бэкенд:** SIWS nonce одноразовый + TTL 5 мин + cap 3/кошелёк ✔; домен из allowlist `SIWS_DOMAINS` + `Issued At` ±5 мин ✔ (**M4** закрыт); cookie HttpOnly + `SameSite=None; Secure` в проде ✔ (fail-fast при `NODE_ENV=production` без `COOKIE_SECURE`/явного CORS/секрета ✔); CSRF double-submit ✔; HMAC сессии ✔; rate-limit по IP/кошельку/сессии + 16 KB тело ✔ (**H3** закрыт); подпись проверяется с try/catch (malformed) ✔; события декодируются только от известных program id и дискриминаторов ✔ (тест); идемпотентность ingest ✔; `rebuild` детерминирован ✔; **остаётся** `confirmed` (**M5**); админ-эндпоинты — 501 (при реализации: allowlist кошельков + подпись SIWS-сообщения с ролью + аудит-лог; kill-switch = вызов `set_paused` через pauser). Секреты не логируются (проверить `pino` redact при внедрении логгера). Prisma-схема — параметризованные запросы ✔ (SQLite-слой использует плейсхолдеры ✔).

**Клиент:** цены/odds/pity — только из on-chain `GameConfig` ✔; `max_lamports` из квоты ✔; crank-симуляция ролла не влияет на исход (программа перепроверяет) ✔; Switchboard SDK — dynamic import ✔; mock-API отключён в production-сборке (проверить `VITE_API_MOCK` guard — T-U-cfg); никаких приватных ключей в bundle ✔; CSP на хостинге (`connect-src` RPC/API/gateway Switchboard; `frame-ancestors` для Telegram); Wallet Adapter — только известные адаптеры + MWA; deep-link'и валидируются.

---
## 3. План тестирования

### 3.1 Пирамида и CI

```
            ┌──────────────┐  T-D  devnet smoke + 14-дневный soak (боты)          ежедневно / перед релизом
            │   E2E        │  T-E  Playwright: mock-режим (PR) + devnet (nightly)
          ┌─┴──────────────┴─┐
          │ Localnet (LiteSVM/validator) │ T-L 76 сценариев, sb_mock + pyth-фикстуры   PR (matrix: programs)
        ┌─┴──────────────────┴─┐
        │ Backend integration  │  T-B  vitest + sqlite; nightly — Postgres+Redis     PR
      ┌─┴──────────────────────┴─┐
      │ Property / fuzz          │  T-P  proptest (Rust) + fast-check (TS)           PR (быстрые) / nightly (10⁶ итераций)
    ┌─┴──────────────────────────┴─┐
    │ Unit: economy · client · Rust│  T-U / T-R                                       PR
    └──────────────────────────────┘
```

CI (`.github/workflows/ci.yml`, добавить): jobs `economy` (`npm run economy:check && npm run economy:test`), `client` (`npm run typecheck && npm test && npm run build`), `backend` (`typecheck && test`), `landing` (`landing:build && landing:check`), `programs` (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace --exclude chip-game`, `anchor build` в контейнере `solanafoundation/anchor:0.31.1`), `localnet` (`anchor test` с `--features localnet`), `e2e-mock` (Playwright против `vite preview` + `VITE_API_MOCK=1`). Nightly: `e2e-devnet`, `fuzz-long`, `load-smoke` (LT-1 на 10 % нагрузки).

Единая команда для приёмки: `npm run verify` = economy:check + economy:test + client typecheck/test/build + backend typecheck/test + landing:check (+ `programs:test` при наличии тулчейна).

### 3.2 Unit (TypeScript) — T-U

Существующие (зелёные): `packages/economy/test/economy.test.ts` (10): Σ odds, pity не ломает сумму и Common ≥ 5 %, границы `rollRarity`, детерминизм/floor/hard-pity `expandRandomness`, 8 рецептов fusion, `expectedBurn`, `guardedEmission`, set-bonus, `matchWinProbability`, бандлы. `client` (72): Borsh round-trip всех аккаунтов/событий, дискриминаторы, `INIT_SPACE` = размер декодера, PDA-деривация, `expandRandomness` на golden, Merkle leaf/proof, форматирование, парсер `PackOpened`, i18n полнота 7 локалей, smoke рендера.

Добавить:

| ID | Тест | Файл |
|---|---|---|
| T-U-01 | `packSeed(value, qty, packNo)` = keccak(value‖packNo) для qty > 1 и = value для qty = 1 (сверка с Rust через golden-вектор `bundle_seed.json`) | `client/src/chain/chain.test.ts` |
| T-U-02 | Таблица Switchboard id по кластерам (`SBond…`/`Aio4…`/mock) и очередей; `defaultQueue()` не возвращает devnet-очередь для mainnet | `client/src/chain/ids.test.ts` |
| T-U-03 | `revealValueFromIx` — layout `8‖64‖1‖32`, отказ на коротких данных | там же |
| T-U-04 | `packFlow` state-machine: `committed → revealing → opening → done`; потеря гонки с crank → продолжение с `fresh.opened`; стейл только после `STALE_SLOTS` | `client/src/chain/flows/packFlow.test.ts` (мок connection) |
| T-U-05 | `fusionFlow`: 100 %-рецепт без randomness; рискованный — с commit; бустер уменьшает `boosters` | |
| T-U-06 | Zustand-селекторы мемоизированы (нет бесконечного цикла) — регресс из фазы 4 | `smoke.test.tsx` |
| T-U-07 | `VITE_API_MOCK` не может быть включён в production-сборке | `app/config.test.ts` |
| T-U-08 | i18n: длина строк VI/ID/RU ≤ 1.6 × EN для кнопок (флаг на дизайн-проверку) | `i18n.test.ts` |
| T-U-09 | economy: `probabilityAtLeast`, `packExpectedValueMult` для 4 SKU в допусках `docs/02 §2.3` (EV Standard ≈ 0.65) | `economy.test.ts` |
| T-U-10 | economy: faucet-инвариант «бесплатный игрок ≤ 20 % ценности медианного платящего» (пересчёт из `docs/02 §3`) | |
| T-U-11 | economy: `guardedEmission` при burn = 0 равно 30 % cap; при burn = cap/1.25 — cap | |

### 3.3 Rust host-тесты (без BPF) — T-R

`cargo test -p chip_core|market|arena|staking`. Существуют: economy.rs 7, market 1 (`split_sums_to_price`), arena 2, staking 5, `tests/golden.rs` 1 (64 вектора).

| ID | Программа | Тест |
|---|---|---|
| T-R-01 | chip_core | `units_for_cents`: SOL @ $150 (expo −8) для 499 ¢ = 33 266 667 lamports; USDC (6 dp) = cents × 10⁴; expo −12/−6; переполнение → `Overflow` |
| T-R-02 | chip_core | скидки: бандл 5/10/25 → −7/−12/−18 %; +SKR 5 %; общий cap 30 %; qty 0 и 26 → `InvalidQuantity` |
| T-R-03 | chip_core | Pyth conf > 2 % → `StalePrice` (после M2); age > 60 с → `StalePrice` |
| T-R-04 | chip_core | `set_params` guard-rails: каждая из 9 проверок падает по отдельности с нужной ошибкой |
| T-R-05 | chip_core | `effective_odds` для всех SKU и pity 0…120: Σ = 10 000, монотонность top-mass, Common ≥ 500 |
| T-R-06 | chip_core | `expand`: floor поднимает последний слот; hard pity; featured_only pool = 1; pool 1…10 |
| T-R-07 | chip_core | golden ×64 (есть) + новый golden `bundle_seed.json` (keccak sub-seed) |
| T-R-08 | chip_core | учёт `liab_*`: buy → +; open last → −; cancel → −; двойное списание → паника (overflow-checks) — через чистые функции учёта, вынесенные из handler'ов |
| T-R-09 | chip_core | `RENT_RESERVE_PER_CHIP × chips` ≥ rent(Core asset 4 плагина) + rent(ChipState) по `Rent::default()` |
| T-R-10 | chip_core | fusion recipes: 8 переходов, `same_collection` на 1/3/5/7, success 100/100/100/100/85/75/70/50, booster +1 500 bps cap 9 500, fee и lock по таблице |
| T-R-11 | chip_core | roll fusion: `uniform_bps(value, 0) < threshold` ⇒ успех; граница threshold |
| T-R-12 | chip_core | `ServiceKind` 0–9: цены в ¢, `daily_cap`, `ref_hash` = keccak(0x00‖kind‖wallet‖payload) — вектор совпадает с backend `services.ts` |
| T-R-13 | market | `split`: sums-to-price (есть), fee clamp 10 %, royalty 250, buyback ⅓; `min_price` по валюте |
| T-R-14 | arena | `league(power)` границы; `validate_squad` дубликаты/флаги (через фикстуры AccountInfo) |
| T-R-15 | arena | rake 5 % = 40/40/20 при pot нечётном (пыль сгорает); cap: `paid_today + pot > cap` → `OracleCap` |
| T-R-16 | staking | `daily_schedule_cap(year)` = 18/15/12/10/8/6/5/4 % × 550 M / 365; сумма 8 лет ≤ 550 M |
| T-R-17 | staking | `guarded_daily`: floor 30 %, burn × 1.25, ≤ cap |
| T-R-18 | staking | сплит 30/15/17/23/15: Σ = 10 000, `set_split` Δ ≤ 1 000 |
| T-R-19 | staking | тиры: boost 1.0/1.5/2.2/3.0, penalty 0/5/10/15 %, lock 0/30/90/180 д |
| T-R-20 | staking | MasterChef: `acc_reward_per_weight` при stake/unstake/claim — сумма выплат ≤ бюджет за период (симуляция 1 000 шагов) |
| T-R-21 | staking | `verify_proof`: leaf/node домены, глубина 24 OK / 25 → ошибка, порядок min/max |
| T-R-22 | staking | `publish_root` бюджет > slice → `BudgetExceeded`; revoke возвращает |
| T-R-23 | staking | `ROOT_TIMELOCK` = 3 600 |
| T-R-24 | все | `chip_core::instructions::chip::{MARKET,STAKING,ARENA}_PROGRAM_ID == market::ID/staking::ID/arena::ID` (защита от рассинхрона после `anchor keys sync`) |
| T-R-25 | все | `cargo clippy -D warnings`; `anchor idl build` без ошибок; размеры `INIT_SPACE` ≤ 10 KB |

### 3.4 Property / fuzz — T-P

Rust: `proptest` (host). TS: `fast-check` (экономика/клиент).

| ID | Свойство |
|---|---|
| T-P-01 | ∀ bytes ∈ [u8;32], sku, pity ≤ 200, pool 1…10: `expand` TS ≡ Rust (через WASM-сборку `economy.rs` или генерацию 10⁴ векторов nightly) |
| T-P-02 | ∀ bytes, slot: `uniform_bps ∈ [0, 10 000)`; распределение по 10⁶ случайным входам — χ² на 100 корзинах p > 0.01 (нет смещения от rejection sampling/fold) |
| T-P-03 | ∀ pack, pity: Σ `effective_odds` = 10 000 ∧ odds[0] ≥ 500 ∧ odds[i ≥ tier] ≥ base |
| T-P-04 | ∀ дерево ≤ 2¹⁶ листьев: `verify_proof(leaf, proof, root)` = true для настоящего листа, false для любого изменённого байта leaf/proof/root; second-preimage (leaf как node) отвергается доменом 0x00/0x01 |
| T-P-05 | ∀ price, fee_bps ≤ 10 000: `split` — seller + fee_bb + fee_tr + royalty = price, ни одно слагаемое не отрицательно |
| T-P-06 | ∀ cents ≤ 50 000 × 25, price ∈ [1, 10¹²], expo ∈ [−12, −4]: `units_for_cents` монотонна по cents, антимонотонна по price, без паники |
| T-P-07 | ∀ последовательность stake/unstake/claim (до 500 шагов, случайные тиры/суммы/время): Σ выплат ≤ Σ бюджетов дня; `total_weight` ≥ 0; никакой claim не превышает `budget_remaining` |
| T-P-08 | ∀ последовательность buy/open/cancel по нескольким pending: `vault ≥ liab_lamports + rent_floor` и `vault_token(mint) ≥ liab(mint)` (модель учёта из T-R-08) |
| T-P-09 | Borsh: ∀ случайный `GameConfig`/`PendingPack`/события — encode(TS) → decode(Rust) → encode = identity (nightly, через vectors) |
| T-P-10 | fast-check: `packSeed`, `bundlePriceCents` (округление вниз, ≥ 50 ¢ на пак), `matchWinProbability` симметрия p(a,b) + p(b,a) = 1 |

### 3.5 Localnet Anchor-сюита — T-L

**Стратегия зависимостей.** Metaplex Core — клон с mainnet (без оракула, чистая программа) ✔. Pyth receiver — клон программы + **фикстура аккаунта `PriceUpdateV2`** (`solana account --output json` с mainnet, в тестах перезаписываем `publish_time` через `setAccount` bankrun/`--account`), или свой `PriceUpdateV2`-совместимый аккаунт под owner `rec5…` через `--account`. Switchboard On-Demand — **не клонировать**: на localnet нет TEE-оракула, reveal никогда не произойдёт. Пишем `programs/sb_mock` (≈ 120 строк): аккаунт с тем же дискриминатором и layout `RandomnessAccountData` (480 B: authority, queue, seed_slothash, seed_slot, oracle, reveal_slot, value, lut_slot, ebuf…), инструкции **с теми же метас и дискриминаторами, что у `sb_on_demand`** (после C3-2 их вызывает наша программа по CPI): `randomness_init(recent_slot)` (создаёт аккаунт с `randomness` — signer/PDA, `authority` — signer; `lut_slot = recent_slot`; reward_escrow/lut не создаёт, но принимает метас), `randomness_commit` (**требует подпись `authority`** и `authority == data.authority`; `seed_slot = slot − 1`, `oracle` = переданный), `randomness_reveal(signature, recovery_id, value)` (требует подпись `authority`; подпись оракула не проверяет; `reveal_slot = slot`, `value`), `randomness_close` (подпись `authority`, лампорты → `authority`), плюс тестовая `set_raw(bytes)` для негативных сценариев (C10, C17). Программы собираются с `--features localnet` → `SB_PROGRAM_ID = sb_mock::ID`. Тесты написаны на vitest поверх **LiteSVM** (`litesvm` 1.4.1, in-process SVM: `warpToSlot`/`setClock`/`setAccount`) — это `npm test`; те же спеки без изменений идут против `solana-test-validator` (`npm run test:validator` = `anchor test`, `LOCALNET_RPC`), где сценарии с подделкой аккаунтов/переводом часов помечены `svmOnly` и пропускаются. Реальный клиентский код (`client/src/chain/*`) импортируется напрямую — это и есть contract-тесты билдерам из `docs/04 §12`. Подробности — `tests/localnet/README.md`.

Замена (сделано): легаси `tests/chip-game.ts` удалён; `Anchor.toml [scripts] test = "npm run test:validator"` (`tests/localnet/run-validator.ts`: копирует keypair sb_mock, `anchor build -- --features localnet`, поднимает validator с `--bpf-program` ×5, клоном mpl-core/Pyth receiver и genesis-дампами `PriceUpdateV2`, запускает vitest); `[[test.validator.clone]] SBond…` убран, `[[test.genesis]]` для `sb_mock.so` добавлен.

Сценарии (каждый — отдельный `it`, изолированный кошелёк, проверка событий через логи и состояния через `fetch`):

**Общие / админ (G)** — T-L-G01 initialize + 10 `create_collection` (Core-коллекции, `Royalties` плагин 250 bps → treasury — M6 закрыт); G02 `set_params` полный патч + каждая guard-rail ошибка; G03 pauser/admin (H2); G04 `propose/accept_admin`; G05 `sweep_vault` не ниже `liab` (после buy без open); G06 `grant_booster` от `rewarder` PDA и отказ от чужого.

**Паки (C)** — C01 Starter: 1/кошелёк, soulbound 7 д (`F_SOULBOUND`, `PermanentFreeze frozen`), `thaw_chip` до срока → ошибка, после `setClock` → OK; C02 Standard SOL с Pyth-фикстурой: lamports = ожидаемым ±1, `max_lamports` ниже → `Slippage`; C03 USDC/$CG/SKR — суммы, `liab_*`, скидка SKR; C04 бандлы ×5/×10/×25 — цена, `PendingPack.qty`; C05 Limited — `daily_cap` 5 → 6-й `DailyCapReached`, событийное окно; C06 `paused` → `Paused`, cancel работает; **C07 open ×3**: `randomness_reveal` (mock) + `open_pack` в одной tx — 3 ассета, `ChipState`, `PackOpened` совпадает с `expandRandomness`, pity, burn/treasury для $CG, закрытие и возврат резерва; **C08 бандл ×5, 5 tx в разных слотах** (C2); C09 ×25 — CU каждого `open_pack` ≤ 400 k (лог `consumed`), общая рента; **C10 fake randomness** (аккаунт от sb_mock с чужим owner через `set_raw` под другой программой) → `RandomnessMismatch` (C1); **C11 cancel до `STALE_SLOTS`** → `NotStale`; **C12 после reveal** cancel → `RandomnessAlreadyRevealed`, open OK спустя 1 000 слотов; **C13 без reveal после `STALE_SLOTS`** → 100 % возврат во всех 4 валютах, `liab_*` = 0, pending закрыт (C3); C14 crank-гонка: два `open_pack` одного pack_no — второй падает, состояние консистентно; C15 неверные `remaining_accounts` (не тот collection_meta для ролла) → отказ; C16 pity: 59 Standard без Legend → 60-й даёт ≥ Legend на последнем слоте (mock value подобран); **C17 rng-PDA (C3-2):** `buy_pack` с randomness-аккаунтом, чей `authority ≠ rng_auth` (sb_mock `init` с чужой authority) → `RandomnessAuthority`; с уже закоммиченным аккаунтом (`seed_slot > 0`) → `RandomnessUsed`; с не-PDA адресом → seeds-ошибка Anchor; **C18** `init_randomness` + `buy_pack` в одной tx — после tx `seed_slot == slot − 1`, `authority == rng_auth`, `PendingPack.randomness == rngPda(0, buyer, nonce)`; повторный `init_randomness` с тем же nonce → аккаунт не пуст → `RandomnessUsed`; **C19** `reveal_randomness` от постороннего кошелька (не buyer) с mock-подписью → `reveal_slot > 0`, затем `open_pack` любым payer; reveal дважды → `RandomnessAlreadyRevealed`; **C20** `close_randomness` до закрытия PendingPack → `InvalidChipState`; после последнего `open_pack` → аккаунт закрыт, `owner` получил ренту (Δ баланса = рента аккаунта + wSOL-эскроу), `rng_auth` — 0 лампортов сверх исходного. Аналоги для fusion (F09–F10) и арены (A08–A09: `init_battle_randomness` + `create_battle`; `close_battle_randomness` только при `Resolved | Cancelled`).

**Fusion (F)** — F01 рецепт 0 (Common→Common+) any-collection, атомарно, fee burn, `PlayerItems` не создаётся; F02 рецепт 1 same-collection: смешанные → `MaterialCollectionMismatch`; F03 рецепт 3 lock 1 ч → `F_LOCK`/`lock_until`; F04 рецепт 4 (85 %) успех: commit (материалы `F_FUSING`, frozen) → reveal → mint, материалы сожжены; F05 провал: 2 сожжены, 1 возвращён (наименьший key — совпадает с backend-тестом), `FusionRevealed{success:false}`; F06 fake randomness (C1); F07 `cancel_stale_fusion` до/после окна, разморозка (C3); F08 fee escrow возврат при cancel (M3); F09 бустер: +15 п.п. (порог 10 000 для 85 %+15), списание, отсутствие → `NoBooster`; F10 материалы в стейке/листинге → `ChipBusy`; F11 дубликат материала → отказ.

**Маркет (M)** — M01 list SOL/USDC/SKR ≥ min, 0.5 $CG сожжён, `F_LISTED`, ассет frozen; M02 list staked/locked → `ChipLocked`; M03 buy SOL: split 7.5 % (⅓/⅔) + 2.5 % royalty, `deliver_sold`, новый владелец, флаг снят; M04 `expected_price` ≠ → `PriceChanged`; M05 self-trade → `SelfTrade`; M06 update_price + cancel; M07 offer USDC: make → accept (продавец не листинговал), TTL истёк → `OfferExpired`, cancel возвращает эскроу; M08 fee > 10 % в config невозможен (guard) и clamp в `split`; M09 листинг после `paused` (решение L: разрешён).

**Арена (A)** — A01 create_battle: эскроу, лига, `MIN_SQUAD_POWER`; A02 accept: `SelfBattle`, лига ≠ → `LeagueMismatch`, > 10 мин → `BadStatus`; A03 resolve: oracle, winner, rake 40/40/20, `result_hash`, escrow закрыт; A04 resolve не-оракулом → `Unauthorized`; **A05 fake randomness** (C1); **A06 cancel_stale** Open (challenger сразу / opponent после 10 мин) и Accepted (после 30 мин, оба возврата); A07 дневной cap → `OracleCap`, сброс через сутки (`setClock`); A08 фишка не владельца/листингованная → `NotOwner`/`ChipBusy`; A09 wager вне [5, 5 000] → отказ.

**Стейкинг (S)** — S01 `init_emission` + `tick_day` (второй в сутки → `DayAlreadyClosed`), слайсы = бюджет × сплит; S02 stake_cg flex → claim через 1 день = budget_per_sec × 86 400 × доля; S03 тир 90 д, ранний выход → 10 % principal сожжено (`record_internal_burn`); S04 `set_split` Δ 1 001 → отказ; **S05 report_burn** от `burn_oracle`/PDA → `guarded_daily` следующего дня растёт (M1); S06 stake_chip: CPI флаг, вес 2 200 для Diamond, unstake снимает; S07 `sync_set_bonus` 1 сет → множитель, 11 → `TooManySets`; S08 unstake при `paused` работает; S09 chip в листинге → stake отказ; S10 `publish_root` бюджет ≤ slice, резерв; S11 `claim_root` до timelock → `RootTimelocked`, после — mint, receipt; повтор → init-ошибка; чужой proof → отказ; S12 `revoke_root` → бюджет возвращён, claim → ошибка; S13 24-уровневый proof проходит, 25 — нет. **SKR pool:** S14 `init_skr_pool(0)` → `max_root_budget = 100 000 SKR`, vault = ATA пула; `fund_skr` 1 000 → `budget`, `SkrFunded`; S15 `publish_skr_root(kind 5)` от quest-oracle: `budget → reserved`; kind 6 от quest-oracle → `BadOracle`; бюджет > `budget` или > кап → `SkrBudgetExceeded`; kind 2 через `publish_skr_root` → `WrongRootCurrency`; S16 `claim_skr_root` до timelock → `RootTimelocked`; после — `transfer` из vault, `reserved −= amount`, `paid_total`, receipt; повтор → init-ошибка; тот же лист через `claim_root` → `WrongRootCurrency` (и наоборот для kind 2 через `claim_skr_root`); S17 `revoke_skr_root` → остаток `reserved → budget`, claim → `RootRevoked`; `revoke_root` на kind 5 → `WrongRootCurrency`; S18 `withdraw_skr` > `budget` → отказ, = `budget` → OK, vault ≥ `reserved` после; S19 прямой SPL-перевод в vault + `sync_skr_pool` → `budget` вырос ровно на разницу, `SkrFunded{funder = default}`; S20 `set_skr_pool(paused = true)` → publish/claim → `SkrPoolPaused`, `fund_skr` работает; инвариант `vault.amount ≥ budget + reserved` проверяется после каждого шага S14–S20.

**Cross-program (X)** — X01 фишка: stake → list (отказ) → unstake → list → buy → новый владелец stake; X02 `set_chip_flag` с поддельным PDA (другая программа с seed `market_auth`) → `NotProgramCaller`; X03 `deliver_sold` без `F_LISTED` → отказ; X04 `level_up` только от `rewarder`.

### 3.6 Backend integration — T-B

Есть (22): health/stats, каталог услуг, market/collections/chip, 501-роуты, auth (nonce, bad sig, reuse, CSRF, logout), handle claim через `ServicePaid`, generic claim + ownership, дискриминаторы/round-trip событий, размер `PackOpened`, CPI-атрибуция, идемпотентность ingest, block_time backfill, rebuild = pure, fusion refund, starter soulbound, floor matrix.

Добавить: T-B-30..34 arena (очередь, матч, seed = sha256(matchId‖commitA‖commitB‖secret), reveal nonce, `/arena/matches/{id}`, награды и лимит 8/день, 3/оппонент, < 20 с без награды, win-trading флаг); T-B-35..37 квесты (прогресс только из событий, streak, кошелёк < 24 ч без покупки → claim deferred, Merkle-корень публикуется в пределах бюджета, proof выдаётся по `/quests/claims`); T-B-38 staking overview/estimate = формула; T-B-39 `/packs/quote` ✅ **сделано** (`backend/test/quote.test.ts`, 12 тестов: фейковый RPC с синтетическими `PriceUpdateV2`, owner/feed/verification/age-валидация как в программе, `amount` = `units_for_cents`, `maxLamports` = × 1.01, 503 при stale/< 15 с/отсутствии аккаунта, 409 starter, 429 daily cap, pity → odds, `/prices`); T-B-40 rate-limit 429 (H3) ✅ и T-B-41..43 SIWS домен из конфига, `issuedAt` drift, CORS allowlist, `COOKIE_SECURE` fail-fast (M4) ✅ — `backend/test/security.test.ts` (10 тестов); T-B-44 дроп confirmed-tx → откат проекции (M5); T-B-45 crank-воркер: `PackBought` → reveal → `open_pack` (с sb_mock на localnet), ретраи, идемпотентность по `(pending, pack_no)`; T-B-46 admin: allowlist + аудит-лог + валидация `set_params` через `packages/economy`; T-B-47 Prisma/Postgres nightly: те же тесты на Postgres 16 + Redis (docker-compose), миграции применяются с нуля; T-B-48 referral: засчитывается только после платного пака, cap 200 $CG; T-B-49 anti-fraud: fingerprint dedupe, IP /24 rate, wash-trade детектор исключает из лидерборда; T-B-50 burn-агрегат = Σ событий (M1).

### 3.7 E2E (Playwright) — T-E

Два режима: **mock** (PR; `VITE_API_MOCK=1`, fake-wallet, детерминированные ответы) и **devnet** (nightly; реальный Switchboard `Aio4…`/очередь `EYiA…`, тест-кошелёк с балансом, Pyth devnet-фид). Устройства: Desktop Chrome, Pixel 6 (Android Chrome эмуляция), iPhone 13 (WebKit); локали: EN + RU на всех сценариях, PT/ES/VI/ID/FIL — смоук-скриншоты (visual regression на 3 ключевых экранах).

| ID | Сценарий | Ассерты |
|---|---|---|
| T-E-00 | Полная петля ACC-1…9 одним кошельком | каждый шаг ≤ 60 с; никаких «undefined»; итоговый профиль содержит фишки/сделку/стейк/клейм |
| T-E-01 | Connect + SIWS + смена языка ×7 | cookie установлен; строки локали; RTL нет; переключатель в табе |
| T-E-02 | Покупка Standard SOL: квота → подпись → pending на Home | цена ± slippage; экран ожидания без кнопки refund |
| T-E-03 | Вскрытие: анимация, skip (без покупки услуги — недоступен), результат = `/verify` | фишки в сетке ≤ 5 с после `PackOpened` |
| T-E-03b | Возврат ренты Switchboard после вскрытия (M7) | баланс вырос на ~0.006 SOL |
| T-E-04 | Коллекция 10 × 9: фильтры, деталь, бонус сета | 90 ячеек; a11y (axe) без critical |
| T-E-05 | Fusion 100 % и рискованный (mock: провал) | UX предупреждения; результат в сетке; материалы исчезли |
| T-E-06 | Маркет: list → другой кошелёк buy → история/floor | комиссии в «чистой зоне» совпадают с событием |
| T-E-07 | PvP обычный + wager (devnet: с оракулом-стендом) | результат, награда, лимит 8/день сообщение |
| T-E-08 | Стейкинг $CG 30 д + фишка; калькулятор | APR = `/staking/estimate` ± 0.1 % |
| T-E-09 | Квест → claim после timelock (mock времени) | receipt; повтор недоступен |
| T-E-10 | Обрыв: закрыть вкладку после `buy_pack` → вернуться → pending виден → довскрыть | нет потерь |
| T-E-11 | Стейл-путь (devnet с отключённым crank и заведомо «мёртвой» очередью — стенд): после окна кнопка refund → возврат | 100 % |
| T-E-12 | Пауза (devnet-стенд): покупка недоступна, cancel/unstake доступны | баннер «техработы» |
| T-E-13 | dApp Store / Android shell (Q8): MWA-подключение через Seed Vault на Seeker-эмуляторе + `fake-wallet`, аппаратная «назад», deep-link `solana-dapp://` в APK | подключение ≤ 30 с; возврат из кошелька сохраняет состояние магазина; Telegram Mini App — вне scope |

### 3.8 Devnet — T-D

T-D-01 smoke после каждого деплоя (buy → open → verify, реальный оракул); T-D-02 **latency-профиль Switchboard**: 1 000 коммитов, распределение commit→reveal-available (p50/p95/p99), доля просрочек > 60 с и > 1 ч (вход для §4); T-D-03 фактические рента/CU: `open_pack ×3/×5`, `fuse`, `buy`, `randomness_init` (rent + LUT), `reveal` CU — заполняем таблицу §4.2 реальными числами; T-D-04 soak 14 дней (G-3) с ботами: 10 000 паков, 500 fusion, 200 wager, инварианты I1–I7 каждые 60 с, 0 зависших pending; T-D-05 chaos: остановить crank на 30 мин → игроки довскрывают сами; убить индексатор → `backfill` догоняет без дублей; Pyth-фид стейл → покупки SOL отклоняются, USDC работают.

### 3.9 Инварианты (мониторинг + тесты)

| ID | Инвариант | Проверка |
|---|---|---|
| I1 | `vault.lamports ≥ liab_lamports + rent_floor`; `vault_ata(mint).amount ≥ liab(mint)` ∀ mint | on-chain (sweep) + монитор |
| I2 | Σ `PendingPack` (paid_*) = `liab_*` (по индексу) | монитор 60 с; T-P-08 |
| I3 | Σ `odds_bps` = 10 000 ∀ SKU; Common ≥ 500; top2 ≤ cap | on-chain guard + монитор после `ParamsChanged` |
| I4 | `minted_total(day) ≤ guarded_daily(day) ≤ cap(year)`; Σ за год ≤ schedule; общий supply ≤ 1 B | монитор + T-R-16/17 |
| I5 | Для каждого `PackOpened`: `expandRandomness(randomness.value, sku, pity_before, pool) == (rarities, collections)` | индексатор пересчитывает каждое событие (`/verify`), расхождение = P0-алерт |
| I6 | Σ `slice_budget` reserved by roots ≤ minted budget; каждый `claim_root` имеет receipt; `claimed ≤ root.budget` | монитор |
| I7 | Ни один `PendingPack`/`PendingFusion`/`WagerBattle(Open/Accepted)` старше 20 мин (crank SLA) и ни один старше `STALE_SLOTS` без действия | монитор, алерт |
| I8 | Бесплатные фишки на кошелёк ≤ 2/нед; $CG из квестов ≤ 15/д, 120/нед; PvP-награды ≤ 8 матчей/д | backend-проекция + тест T-B-35 |

### 3.10 Анти-инфляция / антифрод по источникам (проверки приёмки)

| Источник | Контроль | Тест |
|---|---|---|
| Starter (1 Common Genesis, soulbound 7 д) | on-chain `starter_claimed`; backend fingerprint+кошелёк dedupe; реферал засчитывается после платного пака | C01, T-B-48/49 |
| Дейлики/стрик (≤ 15 $CG/д; фишка 1/нед, SB 3 д) | прогресс только из событий/серверных матчей; Merkle с бюджетом слайса quests 17 %; timelock 1 ч; receipt | T-B-35, S10–S12, I8 |
| Weekly (≤ 120 $CG/нед; фишка 1/нед, SB 7 д) | то же + cap «2 бесплатные фишки/нед» | T-B-35, I8 |
| PvP-награды (2/0.5 $CG; 8/д) | ≤ 3 матча/оппонент/д, < 20 с не оплачивается, win-trading граф, длительность/рейтинг | T-B-30..34 |
| Wager-матчи | эскроу on-chain, rake 5 %, oracle cap/день, `result_hash` + сезонный секрет публикуется | A01–A09 |
| Джекпот стейкинга (10 фишек/нед) | вес = stake weight; VRF сезона; SB 7 д | backend job тест (nightly) |
| Сезон PvP (фишка по лиге, SB 14 д) | 1/сезон/кошелёк; корень сезона с бюджетом pvpSeason 23 % | S10–S12 |
| Рефералы (5 % трат, cap 200 $CG) | начисление только по `PackBought` реферала с реальной оплатой; self-referral по fingerprint отклоняется | T-B-48 |
| Эмиссия $CG в целом | guarded (floor 30 % / burn × 1.25), сплит, `tick_day` раз в день, неистраченное не переносится, **M1** для burn-фида | S01, S05, T-R-16..18, I4 |
| Стоки | 75 % $CG паков burn, 100 % fusion fee burn, listing fee burn, ⅓ market fee buyback-burn, early-exit burn, 40 % rake burn — все эмитят `BurnReported`/учитываются в burn-агрегате | T-B-50 |

### 3.11 Экономические симуляции (не блокируют, но входят в приёмку G-7)

`packages/economy/scripts/report.ts` расширить сценариями: (а) 5 000 DAU baseline из `docs/02 §7.5` — эмиссия vs burn по месяцам; (б) стресс «бесплатный игрок-оптимизатор» — доля ценности ≤ 20 %; (в) «кит»: 25 Limited/день × 30 дней — влияние на floor Legend+/Diamond; (г) pity-worst-case — стоимость гарантированного Legend в USD (Standard 60 паков = $299 без бандлов; должно быть ≥ EV-цены Legend на маркете, иначе арбитраж); (д) SKR-сценарии для §5.

---
## 4. Нагрузка и compute units

### 4.1 Профили нагрузки

| Профиль | Описание | Числа |
|---|---|---|
| P0 «будни» | 5 000 DAU (baseline `docs/02 §7.5`), равномерно | ≈ 0.4 паков/с в пике часа; 30 матчей/мин; 200 rps API |
| **P1 «событие»** (целевой из ТЗ) | Limited-дроп пятница 18:00 UTC, устойчиво | **500 паков/мин ≈ 8.3 `open_pack`/с**; ≈ 3 `buy_pack`/с (бандлы ×5 из-за лимита 5/день); 1 500 rps API; 20 матчей/с |
| P2 «шип» | первая минута дропа / инфлюенсер | 2 000 паков за 60 с ≈ 33 open/с; 400 buy/с-минута (≈ 7/с); 5 000 rps API чтения |
| P3 «хвост» | 30 мин после дропа: маркет + fusion | 5 list/с, 3 buy/с, 2 fusion/с, 3 000 rps API |

Нагрузочные цели — P1 без деградации (§1.3), P2 — без потерь транзакций (допустима задержка вскрытия до 60 с), P3 — p95 API ≤ 250 мс.

### 4.2 Compute units — оценка и лимиты

Две колонки: **оптимистичная** (из `docs/03 §2.8`, Metaplex Core ≈ 17 k CU на `CreateV2` без плагинов) и **консервативная** (4 плагина на ассет, Anchor-десериализация `GameConfig` ~1.5 KB, Pyth/Switchboard парсинг, CPI-overhead). Реальные значения снимаются в T-D-03 и заменяют оценку; `set_compute_unit_limit` = 1.2 × измеренного.

| Транзакция (все ix в одной tx) | Оптимистично | Консервативно | Запрашиваемый лимит | Writable-аккаунты (горячие выделены) |
|---|---|---|---|---|
| `randomness_init` + `randomness_commit` + `buy_pack` (SOL) | 120 k | 350 k | 400 k | **config**, **vault**, pending, pity, buyer, randomness, wSOL-ATA, LUT, oracle |
| `randomness_reveal` + `open_pack` ×3 | 60 k + 3 × 35 k ≈ **165 k** | 80 k + 3 × 120 k ≈ **440 k** (запас → 800 k) | 600 k | **config**, pending, pity, buyer, payer, randomness, **oracle stats (Switchboard)**, 3 × (asset, chip_state, collection_meta, core_collection) |
| `randomness_reveal` + `open_pack` ×5 | 60 k + 5 × 35 k ≈ **235 k** | 80 k + 5 × 120 k ≈ **680 k** (запас → 1.2 M) | 1.4 M (текущее значение клиента; снизить после T-D-03) | то же, 5 × 4 |
| `open_pack` последний в бандле ($CG-оплата: burn + transfer + close) | + 15 k | + 30 k | — | + cg_mint, vault_cg, treasury_cg |
| `fuse` 100 % (3 × `BurnV1` + `CreateV2` + burn $CG) | 190 k | 450 k | 500 k | config, 3 × (asset, chip_state, meta, core_col), result asset/state, owner_cg |
| `fuse` рискованный (freeze ×3 + PendingFusion + commit) | 80 k | 250 k | 300 k | config, pending, 3 × (asset, chip_state), randomness, oracle |
| `randomness_reveal` + `fuse_reveal` | 200 k | 500 k | 600 k | pending, 3 × …, result, stats |
| `list` (freeze CPI + 0.5 $CG burn) | 50 k | 150 k | 200 k | listing, chip_state, asset, seller_cg |
| `buy` (3 transfer + thaw + `TransferV1`) | 80 k | 250 k | 300 k | listing, chip_state, asset, buyer/seller/treasury/buyback |
| `stake_cg` / `unstake_cg` / `claim` | 30 k | 80 k | 100 k | **emission**, **token_pool**, position, wallet_cg, cg_mint |
| `stake_chip` (CPI флаг + freeze) | 60 k | 150 k | 200 k | **emission**, **chip_pool**, position, chip_state, asset |
| `create_battle` (+ init + commit) | 100 k | 300 k | 350 k | battle, escrow, challenger_cg, randomness, oracle |
| `randomness_reveal` + `resolve_battle` | 110 k | 300 k | 350 k | **arena_config**, battle, escrow, winner_cg, season_pool, treasury_cg, cg_mint, stats |
| `claim_root` (proof 24 × keccak) | 30 k | 80 k | 100 k | **emission**, root, receipt, wallet_cg, cg_mint |
| `tick_day` | 20 k | 50 k | 100 k | **emission**, token_pool, chip_pool |

Ограничения рантайма (mainnet, сентябрь 2026): лимит транзакции **1.4 M CU**; лимит блока **100 M CU** (SIMD-0286, активирован 29.07.2026); лимит на **один writable-аккаунт 12 M CU/блок**; слот 400 мс (≈ 2.5 блока/с); размер tx 1 232 B.

**Вывод 1 — пропускная способность по горячему аккаунту `config`.** `open_pack` объявляет `config` как `mut` (нужно только на последнем паке бандла для `liab_*`/`burned_total`), `buy_pack` — тоже (`liab_* +=`). Все эти транзакции сериализуются по `config` в пределах 12 M CU/блок:

| Сценарий | CU/блок на `config` | Доля 12 M |
|---|---|---|
| P1: 8.3 open/с × 440 k + 3 buy/с × 350 k | (3.3 × 440 k + 1.2 × 350 k) ≈ 1.9 M | 16 % ✔ |
| P2: 33 open/с × 440 k + 7 buy/с × 350 k | (13.2 × 440 k + 2.8 × 350 k) ≈ 6.8 M | 57 % ✔ |
| P2 консервативно с запасом (800 k / 350 k) | 13.2 × 800 k + 2.8 × 350 k ≈ 11.5 M | **96 %** ⚠ |

При консервативных CU шип P2 упирается в лимит аккаунта: транзакции откладываются на следующие блоки (задержка растёт, часть протухает по blockhash). **Рекомендация (G-0, ~0.5 дня):** вынести учёт обязательств из `GameConfig` в отдельный `VaultLedger` PDA, шардированный по `buyer.key()[0] % 4` (`["ledger", shard]`); `open_pack` для не-последних паков не пишет ни config, ни ledger; `sweep_vault` суммирует 4 шарда. После этого предел по аккаунтам определяется `vault` (только SOL-покупки/возвраты, ≈ 34 tx/блок = 85 buy/с) и десятью парами `collection_meta`/`core_collection` (естественные шарды). Чем это оплачивается: +1 аккаунт в `buy_pack`/`open_pack`/`cancel`, +2 k CU.

**Вывод 2 — Switchboard как общий ресурс.** `randomness_reveal` пишет в `OracleRandomnessStats` **выбранного оракула** — этот аккаунт общий для всех потребителей Switchboard на Solana; при небольшом числе оракулов в очереди это верхняя граница reveal/с сети в целом, на которую мы не влияем. Off-chain gateway оракула отвечает на HTTP-запрос reveal (клиент/crank) — при P2 это 33 rps в один-два gateway. Действия: измерить в T-D-02 (латентность и отказы при 50–100 rps), согласовать дроп-окно с Switchboard, держать **ORAO VRF** (`VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y`) как второй провайдер за `vrf_provider: u8` в `GameConfig` (v1.1), и **не обещать** мгновенное вскрытие в UI (ожидание до 60 с — норма при событии).

**Вывод 3 — размер транзакции требует LUT.** `reveal + open_pack ×5`: 8 фиксированных + 20 remaining + 13 аккаунтов reveal ≈ 41 ключ × 32 B = 1 312 B > 1 232 B. Обязательна v0-транзакция с **нашей статической Address Lookup Table** (config, vault, cg_mint, treasury, mpl_core, token/system/ATA-программы, 10 × collection_meta, 10 × core_collection, Switchboard programState/queue/wSOL mint/sysvars) — адрес LUT хранится в `client/src/chain/ids.ts` по кластерам и создаётся скриптом `scripts/create-lut.ts` при деплое (G-0). Клиент уже собирает `VersionedTransaction` с `lookupTables` (`client/src/chain/tx.ts`).
> **Статус: сделано.** Измерено (`fitsInTx`, тест «transaction sizing» в `chain.test.ts` и `crank.test.ts`): `reveal + open_pack ×3` — 33 ключа, не кодируется без LUT; `open_pack ×5 + $CG` **сам по себе** ≈ 1 297 B > 1 232 B. Поэтому (а) `scripts/create-lut.ts` (`npm run create-lut -- plan|create|extend|show|freeze`) создаёт статическую таблицу из GameConfig: программы, sysvars, Switchboard state/queue, `config`/`vault`/`rng_auth`, treasury, минты и ATA, 10 × `collection_meta` + 10 × `core_collection` (~60 адресов), адрес → `LOOKUP_TABLE` (crank) и `VITE_LOOKUP_TABLE` (клиент); (б) crank и клиентские flows (`packFlow`, `fusionFlow`) сначала проверяют `fitsInTx([reveal, …settle], lut)`: помещается — одна транзакция, нет — reveal уходит отдельной транзакцией (после посадки это факт цепочки, повтор settle безопасен). Без таблицы 3-фишечные паки работают в две транзакции, 5-фишечные `$CG` — нет: crank паркует задачу с ошибкой `configure LOOKUP_TABLE` (алерт), не угадывая. Таблицу расширять после `create_collection`/`set_params` (`extend` идемпотентен), заморозить на G-1.

**Вывод 4 — комиссии.** Базовая 5 000 lamports/подпись. Приоритетная: `getRecentPrioritizationFees([config, vault])`, p75 за 20 слотов, пол 1 000 µlam/CU, потолок такой, чтобы суммарно ≤ 0.001 SOL/tx (при лимите 600 k CU это ≤ 1.67 M µlam/CU — практически недостижимо; в реальной перегрузке 50–100 k µlam/CU → 0.00003–0.00006 SOL). Бюджет crank на событие P1 длительностью 60 мин: 30 000 open-tx × (5 000 + ~30 000) ≈ **1.05 SOL/час**; плюс вознаграждение оракула за reveal из `rewardEscrow` randomness-аккаунта (величину и плательщика измерить в T-D-03; заложить ≤ 0.002 SOL/reveal). Рента на покупку: PendingPack (~0.002 SOL) + резерв 0.006 × chips + Switchboard init (randomness ≈ 0.004, wSOL ATA 0.002, LUT ≈ 0.002) — **возвращается** при закрытии (M7 — нужен UX).

**Вывод 5 — RPC.** Клиент делает ≈ 15 RPC-вызовов на вскрытие пака (quote, config, pending, pity, simulate, send, confirm-polling, randomness read); P1 → ~125 rps с клиентов + crank + индексатор. Выделенный RPC-план ≥ 1 000 rps с WebSocket-подписками на подписи; лимит 429 обрабатывается экспоненциальным бэкоффом (уже в `prepareReveal`). Индексатор — отдельный endpoint (Geyser/Yellowstone gRPC для событий, JSON-RPC для `backfill`).

### 4.3 Crank-сервис (спецификация, SEC-I2)

> **Статус: реализовано** — `backend/src/crank.ts` (+ `chain.ts` PDAs/декодеры/билдеры, `tx.ts` пайплайн с keypair'ом, таблица `crank_jobs` в `db.ts`, `crankStatus` в `/health`), тесты `backend/test/crank.test.ts`. Отличия от спецификации ниже и почему:
> * **Очередь** — не Redis Stream, а таблица `crank_jobs` в той же БД, что и индексатор (ключ `kind:owner:nonce`, фазы `pending → settled → closed`, `stale`, `abandoned`), плюс два источника обнаружения: `pack_purchases.status = 'pending'` (≈ 1 с после индексации `PackBought`) и раз в `CRANK_SWEEP_MS` (30 с) `getProgramAccounts` по дискриминаторам `PendingPack` / `PendingFusion` / `WagerBattle` — у fusion нет commit-события, а БД может отставать или перестраиваться. Redis появится вместе с Postgres (Prisma) — интерфейс `discoverFromDb/sweepChain/dueJobs` от этого не меняется.
> * **Reveal** — без SDK Switchboard (250 KB, keypair-центричный): `POST {gateway_uri}/gateway/api/v1/randomness_reveal` тем же payload'ом, что `Randomness.revealIx` (`slothash`, `randomness_key` hex, `slot`, `rpc`), `gateway_uri` читается из `OracleAccountData` (@3584) оракула, указанного в randomness-аккаунте; ответ заворачивается в наш `reveal_randomness` (authority = PDA). В gateway передаётся **публичный** RPC кластера (`CRANK_GATEWAY_RPC`), не наш ключевой endpoint. Порядок источников значения: `PendingPack.value` (SEC-C2) → `RandomnessAccountData.value` при `reveal_slot > 0` → gateway. Reveal и settle идут одной транзакцией, если помещаются с нашей LUT (§4.2 вывод 3), иначе reveal — отдельно первым.
> * **Идемпотентность** — по цепочке, не по ack: перед каждой отправкой перечитывается пиннинг-аккаунт; `InvalidQuantity`/`opened > pack_no`/уже раскрытый аккаунт → продолжение с состояния цепочки без учёта как ошибки; программы сами отвергают повтор (asset-PDA `data_is_empty`, `pack_no == opened`). N воркеров на одной БД и рестарты безопасны.
> * **Stale** — crank **никогда** не вызывает `cancel_*`: за окном возврата (10 800 слотов) при молчащем оракуле задача → `stale`, перепроверка раз в 10 мин (поздний ответ оракула всё ещё вскроет пак; после refund игрока — только `close_randomness`).
> * **Бэкофф** 1 → 60 с экспоненциально (спецификация говорила 1 → 8 с — при перегрузке gateway это давало бы шторм запросов), `CRANK_MAX_ATTEMPTS` = 60 (≈ 55 мин при насыщенном бэкоффе — тот же дедлайн) → `abandoned` + ALERT, ретрай раз в час.
> * **Комиссии** — медиана `getRecentPrioritizationFees` по writable-аккаунтам транзакции, пол 1 000 µlam/CU, потолок 200 000 и ≤ 0.001 SOL/tx (вывод 4); лимиты CU фиксированы по составу инструкций (open ×3 700 k, ×5 1 M, fuse 600 k, reveal 150 k, close 150 k) — без симуляции, чтобы reveal (preflight может не совпасть со слотом посадки) не блокировал отправку.
> * **Арена** — crank делает только `reveal_battle_randomness` (permissionless) и `close_battle_randomness` после `Resolved/Cancelled`; `resolve_battle` требует подписи `battle_oracle` и результата матча от арена-сервера (501-заглушка) — это часть арена-сервера, не crank'а.
> * **Мониторинг** — `/health.crank`: `pending/stale/settled/closed/abandoned`, `headAgeS`, `healthy` (≤ 200 в очереди, голова ≤ 60 с, 0 abandoned) + ALERT-строки в логе (баланс ключа < 0.5 SOL, abandoned, SLA). Ключ: только комиссии и авансовая рента (возмещается программой), `CRANK_HARD_FLOOR_SOL` 0.05 — ниже ничего не отправляется, `CRANK_MAX_BALANCE_SOL` 2 — предупреждение. Не покрыто до devnet (T-D-04): измерение p95 commit → PackOpened и стоимости reveal из `reward_escrow`.

- **Вход:** индексатор публикует в Redis Stream `pending:packs` (`PackBought` → `{pending, buyer, nonce, qty, commit_slot, randomness}`), `pending:fusions`, `pending:battles`, а также периодические задачи `tick_day`, `thaw` (по `lock_until`), `randomness_close` (после вскрытия, если authority = PDA).
- **Воркер:** consumer-group, идемпотентность по ключу `(pending, pack_no)`; шаги: дождаться `seed_slot + 1` финализации → `gateway.fetchRandomnessReveal` (бэкофф 1 → 8 с, дедлайн 55 мин) → симуляция → `reveal + open_pack` с динамическим priority fee → подтверждение → ack; при `RandomnessAlreadyRevealed`/`opened > pack_no` — ack (игрок или другой воркер уже вскрыл); при истечении окна — пометить `stale` (игрок получает refund сам; crank не вызывает `cancel_*`, это право владельца).
- **Экономика:** воркер тратит ренту вперёд и получает возмещение из резерва в той же tx; priority fee — расход проекта (≈ 1 SOL/час события); баланс ключа ≤ 2 SOL, автопополнение с алертом.
- **Масштабирование:** stateless, N воркеров = ⌈целевой tx/с ÷ 3⌉ (один воркер ≈ 3 tx/с с учётом подтверждений); P1 → 4 воркера, P2 → 12; порядок FIFO по `commit_slot`; per-shard очереди после внедрения `VaultLedger`.
- **SLA/алерты:** p95 commit→`PackOpened` ≤ 20 с; глубина очереди > 200 или возраст головы > 60 с → алерт; любой pending старше 20 мин → инцидент (I7).

### 4.4 Сценарии нагрузочных тестов

| ID | Что | Инструмент/стенд | Профиль | Критерии прохождения |
|---|---|---|---|---|
| LT-1 API | публичные чтения (`/collections`, `/market/listings` с фильтрами, `/market/floor`, `/stats`, `/leaderboard`) + авторизованные `/me/*` + мутации (`/auth/siws/*`, `/services/claim`) + профиль злоупотребления (H3) | k6, staging (Postgres 16 prod-класс, Redis, 2 реплики API), сид: 50 k кошельков, 2 M фишек, 1 M событий, 200 k листингов | ramp 0 → 5 000 rps чтений за 5 мин, 30 мин плато; 300 rps `/me`; 20 rps мутаций; soak 2 ч на 50 % | p95 ≤ 150 / 250 мс; ошибки < 0.1 %; hit-rate кэша ≥ 90 %; 429 корректны; память API без роста |
| LT-2a Pack storm (localnet) | 1 000 ботов-покупателей, бандлы ×1/×5/×25, crank 4/8/12 воркеров, sb_mock авто-reveal | `solana-test-validator` + tx-generator (`scripts/load/packstorm.ts`), метрики из `getBlock` (CU по аккаунтам) | P1 60 мин, P2 5 мин | 0 потерянных tx; p95 commit→open ≤ 20 с (P1) / ≤ 60 с (P2); CU/блок на `config`/`ledger` < 80 % 12 M; отчёт фактических CU по типам tx |
| LT-2b Pack storm (devnet) | реальный Switchboard `Aio4…`/очередь `EYiA…` | тот же генератор, 50–100 паков/мин, 60 мин (лимиты devnet) | распределение commit→reveal-available p50/p95/p99; доля reveal-отказов; просрочки > 1 ч; CU и рента фактические (T-D-03) | документированный latency-профиль; отказов < 1 %; 0 просрочек |
| LT-2c Dress rehearsal (mainnet) | 200 паков командными кошельками накануне запуска в тихий час | прод-инфра | — | всё как в проде; стоимость/пак; работа алертов |
| LT-3 Indexer | replay 1 M событий (фикстура) через WebSocket-мок + `backfill` с нуля | Node, Postgres | 50 → 200 tx/с | лаг p95 ≤ 5 с при 50 tx/с; `rebuild` даёт идентичный хэш проекций; backfill 1 M ≤ 30 мин; память стабильна |
| LT-4 Crank | очередь 10 000 pending одномоментно; отказ RPC (429/таймауты 10 %); гонки с игроками (30 % паков вскрывают сами) | LT-2a-стенд | — | нет дублей/паник; ack идемпотентен; дренаж 10 000 ≤ 20 мин на 8 воркерах; баланс-алерты |
| LT-5 PvP/матчмейкинг | 5 000 в очереди, 50 матчей/с, wager-оракул 5 resolve/с | k6 + сервис арены + Redis | 30 мин | подбор p95 ≤ 3 с; резолв p95 ≤ 500 мс; сид/секрет корректны; oracle cap не нарушен |
| LT-6 Chaos | остановка crank 30 мин; падение индексатора 10 мин; стейл Pyth; 429 у gateway Switchboard | devnet-стенд | — | игроки довскрывают сами; backfill без дублей; SOL-покупки отклоняются, USDC работают; UI сообщает ожидание, refund не показан раньше срока |

Отчёт по нагрузке (артефакт G-6): таблица §4.2 с фактическими CU, латентности Switchboard, стоимость события в SOL, рекомендованные лимиты CU/priority fee в `client/src/chain/tx.ts` и crank-конфиге, число воркеров.

---

## 5. Открытые вопросы и решения владельца

Статус после ответа владельца (сессия после фазы 6): **Q1 — вариант (б) принят и реализован; Q3 — принято; Q4 — «да», уже было в коде; Q5 — оставить 0.5 $CG.** **Сессия 2026-09-15: Q6, Q7, Q8 — решены владельцем и применены (см. ниже); Q2 закрыт в коде (CPI reveal), остаётся devnet-подтверждение T-D-04.**

1. **SKR как наградная валюта — РЕШЕНО: (б), реализовано.** Владелец выбрал казначейский призовой пул. Реализация: `programs/staking/src/instructions/skr.rs` (`SkrPool ["skr_pool"]`, `init_skr_pool / fund_skr / sync_skr_pool / withdraw_skr / set_skr_pool / publish_skr_root / revoke_skr_root / claim_skr_root`, root kinds 5–7, инвариант `vault ≥ budget + reserved`, кап на корень 100 000 SKR, `WrongRootCurrency` на обоих claim-путях), модель `packages/economy/src/skrRewards.ts` (доли выручки 25/25/15 %, сплит 25/55/20, капы 25 SKR/нед · 2 000/сезон · paid-pack + 7 д, инварианты в `report.ts` §8 и `sync-check`), клиент (`claimSkrRootIx`/`claimAnyRootIx`, Quests с раздельными итогами $CG/SKR), бэкенд (`currency` в `reward_roots/reward_claims`, `skr_pool_events`, `GET /rewards/skr-pool`), документация `docs/02 §7.7`, `docs/03`. **Почему не в USD-эквиваленте emission-guard:** пул финансируется из уже полученной выручки, а не из эмиссии → supply $CG не затрагивается, guard считать в USD не нужно. M2 (EMA + дневной лимит оборота SKR на кассе) остаётся обязательным для расчётной роли SKR. Новые тест-кейсы: T-L-S14–S20 (§3.3, блок «SKR pool»). **Ответ владельца (2026-09-15): казначейский кошелёк `HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho`, доли 15 / 10 / 5 %** (вместо предложенных 25/25/15). Применено: `SKR_POOL_FUNDING = 1500/1000/500`, `SKR_TREASURY_WALLET`, give-back baseline 24 % → 14 % (инвариант отчёта смягчён до ≥ 10 %), `skrPoolDueMicro` + `GET /rewards/skr-pool.funding` (выручка × доли vs внесено), `npm run skr-pool -- plan`, guard подписанта в `fund`, лендинг/docs. Кастодия: адрес on-curve (single-signer), см. §2.5.
2. **Reveal authority (C3-2) — РЕШЕНО в коде, требует подтверждения на devnet.** Во всех 7 доступных копиях IDL `sb_on_demand` (2024-11 … 2026-03) `randomness_reveal.authority` — **signer** (SDK 3.10.6 подписывает только payer, потому что у него authority = payer). С PDA-authority reveal поэтому идёт **только через CPI**: `chip_core::reveal_randomness` / `arena::reveal_battle_randomness` (permissionless, PDA подписывает внутри) — реализовано вместе с init/commit/close (SEC-C3 часть 2). На G-0 остаётся техническая проверка `anchor idl fetch SBond…` (метас/дискриминаторы) и T-D-04 (полный цикл init→commit→reveal→open→close на devnet с `Aio4…`). **Не блокирует разработку; блокирует mainnet-деплой до прохождения T-D-04.**
3. **Окно возврата — РЕШЕНО: `STALE_PACK_SLOTS = 10 800` (~72 мин) принято и применено.** Страховой фонд не делаем. Сделано в этой сессии: константа в `economy.rs` и клиенте, условие `reveal_slot == 0 && seed_slot == commit_slot` в обоих `cancel_stale_*`, копия в 7 локалях (`oneSignature` теперь объясняет: «оракул отвечает секунды, crank вскроет пак даже при закрытом приложении; возврат — после часового окна, ≈ 72 мин»), `docs/02/04`, `programs/README.md`, лендинг (`rules.5`, FAQ) + `check.ts`. Осталось из C3: authority = PDA и crank (бэклог #3, #15).
4. **Роялти на внешних площадках — РЕШЕНО: да, 2.5 %.** Уже реализовано плагином `Royalties` на уровне коллекции (`admin.rs::create_collection`), см. SEC-M6 (закрыт).
5. **Listing fee в $CG — РЕШЕНО: оставить 0.5 $CG (burn).** L4 закрыт как принятый продуктовый выбор; смягчение для новичков — стартовые 12 $CG из дейликов покрывают 24 листинга.
6. **Аудитор — РЕШЕНО: владелец приводит своего аудитора.** Бюджетной строки в плане нет; наша часть — пакет передачи (handoff), собираемый на G-1: (а) frozen-коммит + verifiable build (`solana-verify`), (б) этот документ §2 (SEC-C/H/M/L со статусами) + `programs/README.md` + docs/03 §2.3–2.9 как threat-model, (в) `packages/economy` как спецификация инвариантов (sync-check доказывает совпадение констант), (г) localnet-сюита T-L + fuzz T-P как воспроизводимые тесты, (д) список known-issues из бэклога §6 с явной пометкой «не исправляем до аудита», (е) канал для findings + SLA на ответ 2 рабочих дня; после отчёта — re-audit diff'а до G-2. Scope для аудитора: chip_core (packs/fusion/services/economy/randomness), staking (`skr.rs`, emission), market, arena; вне scope — backend/клиент (наш внутренний ревью §2.6).
7. **Pyth на mainnet — РЕШЕНО: своя публикация цен (own pusher), реализовано.** Спонсируемый SOL/USD обновляется раз в 55 с (слишком близко к 60-секундному окну), SKR/USD не спонсируется вовсе. Сделано: `packages/economy/src/oracle.ts` (политика: shard **0xCA75**, триггеры 30 с / 0.5 % / 50 %, худший возраст 45 с, стоимость ≈ 2 SOL/мес) + 12 проверок в sync-check; `ops/pyth-pusher/` (price-config.yaml, docker-compose с HA-профилем, alerts.yml, runbook с incident-процедурой); `scripts/pyth-pusher.ts` (`accounts | check | cost | set-params-args | quote`); backend `pyth.ts` (декодер `PriceUpdateV2`, валидация 1:1 с программой) + воркер `pyth-cache` → `oracle_prices` + реальный `POST /packs/quote` и `GET /prices`; клиент передаёт `priceUpdateAccount`/`maxLamports` из котировки в `buy_pack`, блокирует подпись без котировки и показывает возраст цены. Аккаунты: SOL/USD `ELp9x5sFxGJ7zTurykU2p6A9nKDx72b3xzPxfsB5S8GB`, SKR/USD `9bCSdQVWckgKipe4G3G66aYU9yq2ZdDn8kRPZB9Nihbc`. Остаток: Hermes API-ключ (Pyth Terminal) и payer-кошелёк заводит владелец на G-0; on-chain conf-guard — бэклог #7.
8. **Дистрибуция — РЕШЕНО: Solana dApp Store эксклюзивно, Telegram Mini App не делаем.** Telegram остаётся каналом комьюнити (ссылка на лендинге). Применено: PRD/архитектура/фронтенд-доки переписаны под dApp Store + MWA, флаг `VITE_FLAG_TELEGRAM` удалён из конфига/типов/.env, T-E-13 переопределён как Android/MWA-сценарий; чек-лист публикации — `dapp-store/PORTAL_CHECKLIST.md`, README §dApp Store.

## 6. Бэклог изменений по итогам фазы 6 (для G-0/G-1)

| # | Изменение | Файлы | Оценка |
|---|---|---|---|
| 1 | `owner = SB_PROGRAM_ID` на всех randomness-аккаунтах + cluster features (C1, H1) | `economy.rs`, `packs.rs`, `fusion.rs`, `arena/lib.rs`, `Cargo.toml` ×3, `Anchor.toml` | 0.5 д |
| 2 | Фиксация `value` в `PendingPack` при первом вскрытии (C2) | `state.rs`, `packs.rs`, клиент-декодер `accounts.ts`, backend `borsh.ts` | 0.5 д |
| 3 | `STALE_SLOTS = 10 800`, условие `reveal_slot == 0`, authority = PDA + CPI commit, CPI reveal/close (C3 части 1–2, M7) | `economy.rs`, `randomness.rs`, `instructions/rng.rs`, `packs.rs`, `fusion.rs`, `arena`, `client/src/chain/{switchboard,ix/rng,pdas}.ts`, флоу, `sync-check` | **сделано** (части 1–2, эта сессия); остаток: `anchor build` + T-L-C17..C20 + T-D-04 |
| 4 | `pauser` роль (H2) | **сделано** (не собрано — нет toolchain): `chip_core::{set_pauser,pause}` + `GameConfig.pauser`, `staking::{set_pauser,pause}` + `EmissionState.pauser`, `arena::{set_pauser,pause}` + `ArenaConfig.pauser`, событие `PauseChanged` ×3; клиент-декодеры; бэкенд `pause_changes` + `/health.paused` + Prisma `PauseChange`; тесты T-L-G03b, T-B pause audit. Остаток: UI админки (кнопка «Pause all» = 3 инструкции в одной tx от pauser) — вместе с админ-панелью | — |
| 5 | Rate-limit + SIWS домен/issuedAt + CORS/cookie fail-fast (H3, M4) | **сделано**: `backend/src/ratelimit.ts` (sliding-window store с интерфейсом под Redis; политики nonce 10/мин/IP + 30/ч/кошелёк, verify 20/мин/IP, чтение 600/мин/IP, мутации 60/мин/сессия, quote 30/мин, claim 10/мин; `429` + `Retry-After` + `RateLimit-*`), тело ≤ 16 KB (413), cap 3 nonce/кошелёк; `SIWS_DOMAINS` allowlist из конфига (заголовок `X-Forwarded-Host` больше не используется), `Issued At` обязателен и ±300 с; `assertProductionConfig()` при `NODE_ENV=production` требует явный `CORS_ORIGINS`, `COOKIE_SECURE=1`, `SESSION_SECRET ≥ 32`, домен. Тесты T-B-40..43 — `backend/test/security.test.ts` (10). Остаток: Turnstile на `/quests/claims` (эндпоинт ещё 501), Redis-store при переходе на Postgres/Redis | — |
| 6 | `burn_oracle` + `report_burn` крон (M1) | **сделано** (не собрано — нет toolchain): `EmissionState.burn_oracle`, `set_oracles.burn_oracle`, `report_burn` clamp 3 × cap; `backend/src/burn-oracle.ts` + `/health.burnOracle`; `burns` дополнен listing fee / rake burn; T-L-S05, T-B burn-oracle ×6; `setup.ts --step burn-oracle`. Остаток: ключ `BURN_ORACLE_KEYPAIR` и его `set_oracles` — владелец на G-0 | — |
| 7 | Pyth conf-guard + EMA для SKR (M2) | **сделано** (не собрано — нет toolchain): `oracle_price` в `packs.rs` (используется и `services.rs`), `PYTH_MAX_CONF_BPS = 200`, `PriceUncertain`; economy/backend/client/localnet зеркала + тесты. EMA — отложено (см. SEC-M2 статус) | — |
| 8 | Fusion fee escrow (M3) | `fusion.rs`, `state.rs` | 0.5 д |
| 9 | `finalized` для денежных проекций (M5) | backend `ingest.ts`, `projections.ts`, схема | 1 д |
| 10 | ~~`Royalties` плагин (M6)~~ — уже в коде, закрыто; остаётся только тест T-L-G01 | `admin.rs::create_collection` | — |
| 11 | Возврат ренты Switchboard в UX (M7) + измерение | `client` (кнопка/авто) — сделано; crank закрывает аккаунты автоматически (фаза `settled → closed`) — сделано; остаётся измерение на devnet | 0.1 д |
| 12 | `VaultLedger` шардирование (§4.2 вывод 1) | `state.rs`, `packs.rs`, `admin.rs`, клиент/бэкенд декодеры | 0.5 д |
| 13 | Статическая LUT + скрипт (§4.2 вывод 3) | **сделано**: `scripts/create-lut.ts` (`plan/create/extend/show/freeze`), `fitsInTx` + split в `client/src/chain/tx.ts`/flows и в crank; адрес через `VITE_LOOKUP_TABLE` / `LOOKUP_TABLE` (создать на G-0) | — |
| 14 | `programs/sb_mock` + `tests/localnet/*` (60 сценариев) + Pyth-фикстура | **сделано** (эта сессия): `programs/sb_mock` (480 B layout, реальные дискриминаторы/метас `randomness_init/commit/reveal/close` + `set_raw`), `tests/localnet/` — 76 сценариев G01–X04 на vitest поверх **LiteSVM** (`npm test`, контроль слотов/часов, `setAccount`) и тех же спеков против `solana-test-validator` (`npm run test:validator` = `anchor test`, 8 svm-only сценариев пропускаются), Pyth `PriceUpdateV2` пишется под owner `rec5…` (LiteSVM `setAccount` / genesis-дамп), `fetch-fixtures.ts` (`mpl_core.so` по JSON-RPC). **Не запускалось**: в sandbox нет Rust/Anchor (`.so`) и RPC — первый прогон на G-0 покажет расхождения спеков с реальным поведением программ (см. tests/localnet/README.md) | 0.5–1 д на первый прогон |
| 15 | Crank-сервис (§4.3) | **сделано**: `backend/src/{crank,chain,tx}.ts`, `crank_jobs`, `/health.crank`, 24 теста; остаток — devnet-прогон T-D-04 (p95, стоимость reveal), Redis/Postgres очередь вместе с Prisma | — |
| 16 | CI-workflow (§3.1), Playwright mock/devnet, k6-скрипты, tx-generator | `.github/workflows`, `e2e/`, `scripts/load/` | 3 д |
| 17 | Удалить `tests/chip-game.ts`, обновить `Anchor.toml`/`package.json` test-скрипты | сделано в этой фазе (см. `tests/localnet/README.md`) | — |
| 18 | SKR-призовой пул (Q1 → (б)): `skr.rs`, kinds 5–7, клиент/бэкенд/экономика/доки, ops-CLI `scripts/skr-pool.ts` (init/fund/sync/status/test-mint), Prisma `RewardCurrency`/`SkrPoolEvent` | **сделано** (эта сессия); остаются локалнет-тесты T-L-S14–S20 (входят в #14) и oracle-джоб «Seeker week» / сезонные SKR-корни в бэкенде | 1 д (oracle-джоб) |
| 20 | Pyth: свой pusher (Q7) — `oracle.ts` + sync-check, `ops/pyth-pusher/*`, `scripts/pyth-pusher.ts`, backend `pyth.ts`/`pyth-cache.ts`/`quote.ts` + `/packs/quote`, `/prices`, клиент (quote → `buy_pack`, UX stale), openapi + типы, docs/03 §2.9 | **сделано** (эта сессия); остаток на G-0: Hermes-ключ, payer, `set_params` на наши аккаунты, Pyth-фикстура для localnet (#14) | — |
| 21 | dApp Store эксклюзив (Q8): доки 00/03/04/06, README, удаление `VITE_FLAG_TELEGRAM`, T-E-13 → MWA/Android | **сделано** (эта сессия) | — |
| 22 | Handoff-пакет для аудитора владельца (Q6): frozen commit, verifiable build, known-issues, канал findings | G-1 | 0.5 д |
| 23 | `randomness_close_lut` (рента LUT ≈ 0.0015 SOL после cooldown) — CPI от PDA `rng_auth` + batch в crank; метас взять из `anchor idl fetch SBond…` на G-0 | `randomness.rs`, `instructions/rng.rs`, crank | 0.5 д |
| 19 | Копия окна возврата «≈ 2 мин» → «≈ 72 мин» + константа 10 800 + условие `reveal_slot == 0` (Q3, C3 часть 1) | **сделано** (эта сессия): `economy.rs`, `packs.rs`, `fusion.rs`, `chipCore.ts`, локали ×7, docs/02/04, README, лендинг | — (из #3 остаются PDA-authority + CPI commit ≈ 1 д) |

Итого до G-2 ≈ 11–13 инженерных дней (без аудита и soak-периода); #18 добавляет ≈ 1 день на oracle-джоб; #3 (части 1–2), #14, #20–21 закрыты в этой сессии (для #14 остаётся первый реальный прогон после `anchor build`), #22 — 0.5 д, #23 — 0.5 д.
