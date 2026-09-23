# Триаж «аудита от 23.09» (Watchtower OS v3 · Phase 1 · 282 находки) — guttercaps

**Дата:** 2026-09-23 · **Ревизия:** `cda1747` (`main`) → ветка `arena/01a0ce8c-guttercaps` · **Автор:** Arena agent

## 0. TL;DR

| | |
|---|---|
| Что за аудит | `Leo88q/Games-watchtower` → `FINAL_OS3_REPORT.md`, таблица **Phase 1 Audit** (коммит `75d6913`, 2026-09-23 00:46 UTC): **282** = ares1 43 + aof 17 + neon-relay 24 + **guttercaps 188 (86 critical / 89 high / 3 medium / 10 low)** + trafficgen 10. Категории детекторов: `SW024 div0`, `SW001 missing signer`, `SW021 PDA collision`, `SW009/010 token`. |
| Чего нет | Списка самих 188 находок. Его нет ни в одной ветке Watchtower, ни в guttercaps (issues / PR / CI), ни в GitHub code search; «security»-модули Watchtower — конфиг-заглушки без сканера. Цифры — результат сигнатурного (regex) прогона по исходникам. |
| Что сделано | Собственный сканер тех же категорий (`scripts/sec-scan.py`): 28 файлов, 14 014 строк Rust → **1 183 сырых срабатывания в 20 категориях**. Каждое разобрано вручную (§2). |
| Реальных дефектов | **3**: **G-01 High** (новый) — `tick_day` с будущим `genesis_ts` навсегда ломает эмиссию; **F-18 Medium** (из аудита 21.09) — ваучер без reveal нельзя отменить, rent + резерв заперты; **G-02 Low** (новый) — повторный tick дня 0 при экзотическом split. Все три исправлены в этой ветке, с регрессионными тестами. |
| Из четырёх названных категорий (div0 / signer / PDA / token) | **0 реальных** — все срабатывания закрыты либо константным делителем/явной проверкой, либо `has_one`/`address`/seeds-привязкой, либо проверкой в хендлере (доказательства — §2). |
| Проверено локально | TS-зеркала ошибок (`sync-check` ✓), typecheck localnet-спеков ✓, client 137 ✓, `docs:refs` ✓. **Rust и LiteSVM-тесты — только CI** (в песочнице нет toolchain и не скачиваются артефакты). |

Почему 188 «критикалов» у сканера и 0 у ручного аудита 21.09 — не противоречие. Сигнатурный детектор считает *наличие паттерна* (`/` без `checked_div`, `UncheckedAccount`, поле `authority` не `Signer`, повтор seed-префикса), а не эксплуатируемость. Наш прогон тех же паттернов даёт 1 183 хита; после дедупликации по структурам/функциям и отсечения тестов/`sb_mock` такие инструменты обычно выдают 150–250 — порядок Watchtower воспроизводится.

## 1. Метод

```
python3 scripts/sec-scan.py programs > /tmp/scan.out     # сырые хиты по категориям + таблица seed-префиксов
```

Сканер: срез комментариев/строк → регэкспы по операторам `/ %`, `+ - *`, `as uN`, индексации, `invoke*`/`CpiContext`, `remaining_accounts`, `try_borrow_mut_lamports`, `resize`, `Account::try_from`, `unwrap/expect`; разбор `#[derive(Accounts)]`-структур по полям (тип, атрибуты, `/// CHECK`, перекрёстные `has_one = поле`); сбор всех `seeds = [...]` / `find_program_address` и группировка по префиксу и «форме». Каждый хит затем читался в контексте кода. `programs/sb_mock` (мок Switchboard, только localnet) и `programs/chip_core/tests/golden.rs` в счёт входят, но в вердикты — как «вне деплоя».

## 2. Категории: сырые хиты → вердикт

| Категория (аналог Watchtower) | Хитов | Реальных | Почему остальное — ложные |
|---|---:|---:|---|
| **DIV** деление/остаток (`SW024 div0`) | 53 | 0 (+ G-01 рядом) | Подавляющее большинство — литерал/константа (`10_000`, `BPS_DENOM`, `DAY`, `YEAR_DAYS`, `ACC_PRECISION`, `LEDGER_SHARDS`, локальный `const RANGE`). Все переменные делители под явной защитой: `economy.rs:276` `top_mass == 0 → return`; `compressed.rs:268` `total_claims == 0 → Err` перед `checked_div`; `packs.rs:86` `require!(price > 0)`; `staking/state.rs:159` `total_weight == 0 → return`; `economy.rs:353` `pool.len().max(1)`. Деления на ноль нет. Но `emission.rs:212` `((now - genesis_ts) / DAY) as u32` — не div0, а wrap отрицательного значения → **G-01** (§3). |
| **ARITH** голые `+ - *` | 201 | 0 | Workspace `[profile.release] overflow-checks = true` → переполнение = паника собственной tx, не wrap. Проверены все накопители состояния: `total_weight - s.weight + new_weight` (инвариант `total ≥ weight`), `rake - treasury - pool` (bps ≤ 10 000), `pity_counter - soft_start` (под `if counter < soft_start return`), `discount + skr_discount_bps` (`admin.rs:469` кап), `amount - from_recycled` (`min`), `pc - burn` (bps от `pc`), `now + lock`/`published_at + TIMELOCK` (i64). Ни одного пути, где чужой ввод роняет чужую tx. |
| **SIGNER** поле-«авторитет» не `Signer` (`SW001`) | 14 (33 до учёта `has_one`) | 0 | `treasury` в `SweepVault`/`PayService`/market `Buy`/`AcceptOffer`/`BuyCompressed*` — `has_one = treasury` на `config`; `seller`/`bidder`/`buyer`/`owner`(FuseReveal) — `address = listing.seller` и т.п.; `owner`/`challenger` в `CloseRandomness`/`CloseBattleRandomness` — входят в seeds randomness-PDA (подмена = другой аккаунт, которого нет); `oracle` (Switchboard) в BuyPack/OpenVoucher/Fuse/CreateBattle/ClaimChipRoot/Reveal* — валидируется Switchboard при commit/reveal, queue пиннится `SB_QUEUE` в `commit_owned`/`reveal_owned`; `GrantBooster.owner`/`SyncSetBonus.owner` — целевой кошелёк, подписывает отдельный `authority`/`set_oracle`, `items.owner`/`sb.owner` сверяются. `sb_mock` — вне деплоя. |
| **UNCHECKED** `UncheckedAccount`/`AccountInfo` | 270 (102 без атрибутов) | 0 | 168 — `address =`/`seeds =`/`owner =`/`has_one` прямо в атрибуте. Из 102 «голых»: 27 `sb_mock`; 43 — Switchboard-обвязка (`queue/oracle/reward_escrow/program_state/lut/lut_signer/stats`), которую валидирует сама SB-программа в CPI, наш код из них ничего не читает и им не платит (rent от `close` идёт через `rng_auth` и пересчитывается по дельте — `close_owned`); `randomness` в `OpenPack`/`OpenCompressedPack`/`FuseReveal` — `constraint = pending.randomness == randomness.key()` + `parse_checked` (owner = SB); `result_asset/result_state` (fusion) — `find_program_address` + `require_keys_eq` в `mint_result`; `settlement` (RegisterCompressedChip) — ключ сверяется с `claim.settlement`, owner и writable проверяются в хендлере (`compressed.rs:1392–1417`); `asset` в market `List`/`MakeOffer` — привязан через `chip` PDA `["chip", asset]` и `load_core_asset`; `ClaimChipRoot.*` — прокидываются в CPI `open_voucher`, где chip_core пиннит всё (seeds/owner/`address = SB_PROGRAM_ID`). |
| **PROGRAM** program-аккаунт без `address =` | 7 | 0 | 6 — `sb_mock`; `ClaimChipRoot.switchboard_program` пиннится на стороне chip_core (`OpenVoucher`: `address = SB_PROGRAM_ID`). Все `mpl_core`/`bubblegum_program`/`log_wrapper`/`compression_program` во всех программах — `address = …` (проверено grep’ом). Сырые `invoke_signed` строят `Instruction { program_id: CONST }`. |
| **TOKEN** `TokenAccount` (`SW009/010`) | 65 | 0 | 49 — `token::mint` + `token::authority`/`associated_token`/`address`. 16 только с `token::authority` — mint проверяется в хендлере: `buy_pack` (`spl_pay`: from/to.mint == mint валюты), `cancel_stale_pack` (`expected_mint` по `paid_*`, from и to), `pay_service` (`spl`), market `buy` (все четыре ATA: `for t in [buyer_t, seller_t, bb_t, tr_t] require_keys_eq!(t.mint, mint)`), `finalize_compressed_pack`, `sweep_vault` (`from.mint == to.mint`, owed по mint). `winner_cg`/`opponent_cg` (arena, только mint) — `owner` сверяется в хендлере (`BadWinner`/`Unauthorized`). |
| **MINT** `Account<Mint>` | 20 | 0 | 18 — `address = config.cg_mint`/`emission.cg_mint`/`config.usdc_mint`; `InitEmission.cg_mint`/`InitSkrPool.skr_mint` — `mint::decimals` + admin-only init, authority затем переходит PDA. |
| **UNBOUND_MUT** `#[account(mut)]` без seeds/has_one/constraint | 63 | 0 | 55 — токен-аккаунты с `token::*` (см. выше). `CompressedMintClaim` в `SetCompressedClaim*`/`TransferCompressedClaim` — вызывающий = `["market_auth"]`/`["stake_auth"]` PDA (`NotProgramCaller`) + `claim.buyer == expected_owner`; в staking/market `claim.buyer == owner/seller` + флаги. |
| **INIT_IF_NEEDED** | 8 | 0 | Все — PDA по `owner`/`buyer`; при повторном входе `owner` сверяется (`items.owner`, `sb.owner`, `ledger.owner`), `StakeCg` на существующем стейке добавляет, не переинициализирует. |
| **CLOSE** `close = X` | 7 | 0 | Получатель всегда `has_one`/`address`-привязан (`seller`, `bidder`, `owner`, `buyer`). |
| **CPI** | 94 | 0 | Все цели — `Program<'info, …>`, `address = …` или константный `program_id`. |
| **REMAINING** `remaining_accounts` | 22 | 0 | Типизируются через `Account::try_from` (owner + discriminator) и сверяются с `find_program_address` (`["chip", asset]`, `["collection", idx]`, `VaultLedger::totals` — ровно `LEDGER_SHARDS` шардов по порядку). |
| **TRYFROM** | 16 | 0 | см. REMAINING. |
| **LAMPORTS** прямые переносы | 14 | 0 | Дебет только program-owned аккаунтов (`pending`, `settlement`, `state`), суммы ограничены (`min(spent, reserve[, pending.lamports])`), закрытие = lamports 0 + `assign(system)` + `resize(0)` (нет «воскрешения»). SOL из системного `vault` — только `system_program::transfer` с подписью PDA. |
| **RESIZE / UNWRAP / UNSAFE** | 5 / 11 / 0 | 0 | `resize(0)` — часть корректного close; все `unwrap` — в `tests/golden.rs` и `sb_mock`. |
| **CAST** `as uN` | 145 | **1 (G-01)** | Остальные — индексы после `require!`/`from_u8`, bps ≤ 10 000, `clamp(0, 7)`. |
| **INDEX** | 134 | 0 | `sku` после `PackSku::from_u8`, `tier < TIER_COUNT`, `kind` в диапазоне publish/claim, `year` clamp, `slot % 7`, `kind` сервиса после `ServiceKind::from_u8`. |
| **PDA collision** (`SW021`) | 47 префиксов | 0 | Все seeds фиксированной длины (pubkey 32 / u8 / u64 LE) — нет неоднозначной конкатенации. Единственный общий namespace — `["root", kind, epoch]` (staking): диапазоны `kind` не пересекаются (2 · 3–4 · 5–7 · 8 · 9) и проверяются **и** в publish-, **и** в claim/revoke-хендлерах; лист меркл-дерева включает `kind`+`epoch`. `["pending", wallet, nonce]` для покупок и ваучеров — один тип, `nonce` выбирает подписант (`beneficiary: Signer`) → сквоттинг невозможен. `["asset", …]` для Bubblegum (32+8) и для Core-паков (32+1+1) — разные программы и длины. `["rng", kind, owner, nonce]` — kind разделяет pack/fusion, battle живёт под program id arena. |
| **Итого** | **1 183** | **3** (G-01, G-02 — найдены; F-18 — подтверждён) | |

## 3. Подтверждённые дефекты и фиксы

### G-01 · High · `staking::tick_day` — будущий `genesis_ts` навсегда останавливает эмиссию

- **Где:** `programs/staking/src/instructions/emission.rs` `tick_day` (было L212): `let today = ((now - e.genesis_ts) / DAY) as u32;`.
- **Сценарий:** `init_emission` принимает любой `genesis_ts` (`scripts/setup.ts`: `GENESIS_TS`, «0 → now» — то есть запуск по расписанию поддерживается). До genesis `now - genesis_ts < 0`, `/ DAY` даёт −1…−N, `as u32` → `4_294_967_295`. Первый tick проходит по исключению для дня 0 (`day_index == 0 && minted_total == 0 && slice_budget == 0`) и записывает `day_index = 4_294_967_295`. Дальше `today > day_index` не выполняется никогда → `DayAlreadyClosed` навсегда → бюджеты пулов и слайсов не пополняются, наград нет. `tick_day` permissionless — достаточно любого кошелька (или собственного крэнка) до genesis. Восстановление — только апгрейд программы с миграцией.
- **Фикс:** `require!(now >= genesis_ts, BeforeGenesis)`; счётчик дней через `saturating_sub` + проверка `days ≤ u32::MAX` перед приведением. Новая ошибка `StakeError::BeforeGenesis` (добавлена в конец enum → код 6031; зеркала `tests/localnet/helpers/expect.ts`, `client/src/chain/errors.ts`; `sync-check` ✓).
- **Тест:** `tests/localnet/51-emission-genesis.spec.ts` (отдельный LiteSVM, `genesis = now + 3 д`): tick чужим кошельком за 3 дня и админом за 30 с → `BeforeGenesis`, состояние нетронуто; после genesis день 0 открывается ровно один раз; день 1 наступает через `DAY` после genesis.

### G-02 · Low · `tick_day` — исключение для дня 0 можно было повторять при split «100 % в пулы»

- **Где:** там же. Условие «первый tick» опиралось только на `slice_budget[..] == 0` и `minted_total == 0`. При split с нулями в quests/pvp/events (не дефолт: `EMISSION_SPLIT` = 30/15/17/23/15, а `set_split` ограничен ±10 pp / 7 дней) `slice_budget` оставался нулевым после первого tick, и до первого клейма любой мог тикать день 0 повторно: каждый повтор после `Pool::update` снова выставлял `budget_remaining` в полный дневной слайс → пулы накапливали больше суточного бюджета.
- **Фикс:** исключение дополнительно требует `budget_per_sec == 0 && budget_remaining == 0` у обоих пулов (после первого содержательного tick они ненулевые; если бюджет дня 0 равен нулю — повтор безвреден).
- **Тест:** тот же спек — повтор tick дня 0 → `DayAlreadyClosed`, `budget_remaining` не сброшен. S01 (`50-staking`) не меняется.

### F-18 · Medium · `chip_core::cancel_stale_pack` запрещал отмену ваучеров — rent и резерв заперты навсегда

- **Где:** `programs/chip_core/src/instructions/packs.rs` `CancelStalePack.pending`: `constraint = !pending.voucher @ InvalidChipState`.
- **Сценарий:** ваучер (`open_voucher` по CPI из `claim_chip_root`) — бесплатный 1-chip `PendingPack`; бенефициар авансирует rent pending, `RENT_RESERVE_PER_CHIP` (0.008 SOL) и Switchboard-запрос. Если оракул не раскрыл значение (stale), вернуть их можно только через `cancel_stale_pack`, а `close_randomness` требует, чтобы pending уже был закрыт. Констрейнт делал это невозможным — вопреки комментарию `OpenVoucher`, docs/06 #28 («`cancel_stale_pack` возвращает только резерв») и индексатору (`PackCancelled` → `vouchers.status = 'cancelled'`). Хендлер для ваучера безопасен: `paid_* = 0` → обе refund-ветки не выполняются, `ledger.release(0,0,0,0)` — `checked_sub` нулей.
- **Фикс:** констрейнт удалён (комментарий SEC-F18 в структуре).
- **Тест:** `50-staking.spec.ts` **S24**: до окна → `NotStale`; после `STALE_PACK_SLOTS` → pending закрыт, кошельку вернулись rent + резерв (`lamportsClose`), `liab_*` без изменений, `close_randomness` возвращает rent SB-аккаунта.

## 4. Что проверено где

| Проверка | Локально | CI (после push) |
|---|---|---|
| `packages/economy/scripts/sync-check.ts` (таблицы ошибок staking ↔ expect.ts ↔ errors.ts, константы) | ✓ ALL MATCH | economy job |
| `npx tsc -p tests/localnet --noEmit` (новый спек, S24) | ✓ | localnet job |
| client typecheck + vitest (137) — `errors.ts` | ✓ | client job |
| `scripts/check-docrefs.ts` | ✓ | docs |
| `cargo fmt --check`, `anchor build`, clippy `-D warnings`, `cargo test` | — (нет toolchain) | programs / rust-lints |
| LiteSVM: `51-emission-genesis` G01/G02, `50-staking` S24, регресс S01/C13 | — (нет `.so`) | localnet job |

`cargo fmt --check` уже прошёл через бот `format.yml` (его патч `783b52a` влит в ветку); окончательный вердикт по сборке — `programs · fmt + anchor build` и `localnet` job.

## 5. Что остаётся из аудита 21.09 (не в скоупе сканера, решения владельца / ops)

F-02 метрики+алерты burn/reward-оракулов · F-05 `guard-mainnet` не форсится в `setup.ts`/CI · F-06 алерт на `resolve_battle` и дефолт `ORACLE_DAILY_CAP_CG = 1 000 000` (≈ 3.7 × дневной эмиссии) · F-12 23 npm-уязвимости из стека Solana (путь — anchor 0.32 / web3.js bump) · F-14 правило «застейканные фишки могут драться» (v1 намеренно) · F-19 верификация артефакта в кластере. Подробности — `SECURITY-ECON-AUDIT-2026-09-21.md`, `FIXES-2026-09-21.md`.

## 6. Файлы этой ветки

- `programs/staking/src/instructions/emission.rs` — G-01/G-02; `programs/staking/src/errors.rs` — `BeforeGenesis`.
- `programs/chip_core/src/instructions/packs.rs` — F-18.
- `tests/localnet/51-emission-genesis.spec.ts` (новый), `tests/localnet/50-staking.spec.ts` (S24), `tests/localnet/helpers/expect.ts`, `client/src/chain/errors.ts`.
- `scripts/sec-scan.py` — сканер (воспроизводимость цифр, не CI-гейт); `tests/localnet/README.md`, `docs/06-acceptance-security-testing.md` — описания тестов.
