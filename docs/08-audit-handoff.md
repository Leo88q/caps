# 08 · Handoff-пакет для аудитора (бэклог #22, решение владельца Q6)

> Владелец приводит своего аудитора; этот документ — то, что он получает в первый день.
> Он **самодостаточен**: что аудировать, как собрать, что уже известно, чего мы сами не смогли
> проверить, куда слать findings и как мы на них отвечаем. Всё, что здесь помечено `⚠ не собрано`,
> означает буквально: код написан и покрыт TS-зеркалами/спеками, но в среде разработки не было
> Rust/Anchor-тулчейна и сети до crates.io, поэтому ни `anchor build`, ни `cargo test`, ни
> localnet-сюита не выполнялись. Аудит начинается с G-0 (сборка) — см. §2.

---

## 1. Что аудируется

### 1.1 Замороженный коммит

| Поле | Значение |
|---|---|
| Репозиторий | `Leo88q/caps`, ветка `arena/01a09dab-caps` |
| **Frozen commit** | заполняется на G-1 (`git rev-parse HEAD` после `anchor build` + `anchor keys sync` + первого зелёного `npm test` на localnet); до этого аудитор работает с HEAD ветки и фиксирует хэш в отчёте |
| Тег | `audit-v1-<yyyymmdd>` (создаёт tech lead в момент заморозки; любые правки после тега — отдельный дифф в §6) |
| Тулчейн | `Anchor.toml`: anchor 0.31.1, solana 2.1.21; `anchor-lang 0.31.1`, `anchor-spl`, `mpl-core 0.12.1`, `switchboard-on-demand 0.13.0`, `pyth-solana-receiver-sdk =1.0.1` (см. `programs/*/Cargo.toml`) |

### 1.2 Скоуп (in)

| Программа | Файлы | LOC (Rust) | Что защищает |
|---|---|---|---|
| `chip_core` (`GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q`) | `programs/chip_core/src/**` — `lib.rs`, `state.rs`, `economy.rs`, `randomness.rs`, `errors.rs`, `instructions/{admin,packs,fusion,chip,services,rng}.rs` | ≈ 3 190 | покупка/вскрытие паков (Pyth-цена, VRF Switchboard On-Demand, pity, floors, бандлы), fusion (атомарный и рандомизированный, эскроу комиссии), `ChipState` флаги/локи, платные услуги (`ServicePaid`), админ-параметры с guard-rails, mint/burn $CG-обязательства через `VaultLedger` |
| `market` (`GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz`) | `programs/market/src/**` | ≈ 560 | листинги без эскроу (freeze через chip_core CPI), покупка/офферы в SOL/USDC/SKR, комиссия 7.5 % (⅓ buyback / ⅔ казна) + роялти 2.5 %, listing fee 0.5 $CG burn |
| `staking` (`GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA`) | `programs/staking/src/**` — `lib.rs`, `state.rs`, `instructions/{emission,stake,skr}.rs` | ≈ 1 415 | **единственный держатель mint authority $CG**: эмиссионный график + guard `min(cap, 0.30·cap + 1.25·burn7d)`, пулы MasterChef (токены/фишки, тиры 0/30/90/180 д), Merkle-корни наград (kind 2–4 $CG, 5–7 SKR из призового пула), `report_burn`, роли оракулов, пауза |
| `arena` (`GCfERiohebYDJLtNwAZpGxudwbXRqnxmuTT413fkTYrM`) | `programs/arena/src/lib.rs` | ≈ 655 | wager-битвы: эскроу $CG, лиги по squad power, VRF-привязка сида, `resolve_battle` от `battle_oracle` с дневным капом, рейк 40/40/20, таймауты 10/30 мин |
| Общий CPI-контур | `chip_core::set_chip_flag` (вызывают market/staking), `staking::report_burn` (burn-oracle), Metaplex Core `PermanentFreeze/Transfer/Burn` делегаты, Switchboard `randomness_init/commit/reveal/close` через `rng_auth` PDA | — | границы доверия между программами |

**Off-chain, в скоупе как «источник подписей»** (не как код для формальной верификации, но аудитор должен увидеть, что ключи не могут сделать больше, чем on-chain позволяет): `backend/src/{crank,burn-oracle,reward-oracle,battle-resolver}.ts` — четыре кипера с горячими ключами; `backend/src/merkle.ts` (дерево наград) и `backend/src/arena.ts` (commit–reveal ранкеда, без денег on-chain).

### 1.3 Вне скоупа (out)

`programs/_legacy_chip_game` (история, не деплоится), `programs/sb_mock` (localnet-заглушка Switchboard, никогда не в `[programs.devnet]`), `client/` (кроме билдеров инструкций как справки), лендинг, `ops/pyth-pusher` (permissionless-инструкция Pyth receiver; отдельный ревью ключа payer'а — §5), Prisma-схема (Postgres-миграция ещё не включена).

---

## 2. Как собрать и проверить (G-0 для аудитора)

```bash
git clone https://github.com/Leo88q/caps && cd caps && git checkout <frozen-commit>
npm install                                  # workspaces: packages/economy, client, backend

# 1. TypeScript-половина (работает без Rust; ≈ 60 с)
npm run verify                               # economy invariants + golden + sync-check, client 91, backend 111, landing

# 2. Программы (нужны anchor 0.31.1 / solana 2.1.21 / rust stable)
anchor build                                 # ⚠ первый в истории проекта запуск — ожидайте правки компиляции
anchor keys sync                             # затем сверить chip.rs:20–22 и `npm run economy:check` (sync-check ловит дрейф id)
cargo test --workspace                       # 17 #[test] + tests/golden.rs (64 golden-вектора: odds, pity, fusion, merkle)
anchor build -- --features localnet          # сборка с sb_mock как SB_PROGRAM_ID

# 3. Localnet-сюита (77 сценариев на LiteSVM + те же спеки против solana-test-validator)
cp tests/localnet/fixtures/sb_mock-keypair.json target/deploy/
npm run localnet:fixtures                    # mpl_core.so с mainnet (git-ignored)
npm test                                     # LiteSVM
npm run test:validator                       # = anchor test

# 4. Verifiable build (для сравнения с деплоем на devnet/mainnet)
solana-verify build --library-name chip_core   # и market / staking / arena
```

Что считать «сборка прошла»: `anchor build` без ошибок для 4 программ + `sb_mock`, `cargo test` зелёный, ≥ 70 из 77 localnet-сценариев зелёные с первого раза (остальные — ожидаемые расхождения спеков, §4.3), `npm run economy:check` подтверждает, что Rust-константы совпадают с `packages/economy` (`sync-check` сравнивает odds/pity/fusion/staking/rake/reserve/program-id из исходников Rust).

---

## 3. Модель угроз и что уже проверено

- Полная модель угроз, границы доверия, чеклист по инструкциям и семантика паузы: **`docs/06-acceptance-security-testing.md` §2.1–2.6**. Аудитор не обязан их переписывать — просим подтвердить или опровергнуть каждую строку §2.3 (чеклист «что проверено статически») и добавить то, чего там нет.
- Экономические инварианты (эмиссия ≤ график, сумма odds = 10 000, pity не ломает сумму, fusion-цепочка 0→8, set-bonus ≤ 1.7×, роялти/комиссии, SKR-пул ≤ фондирования): `packages/economy/scripts/report.ts` + `test/economy.test.ts`; Rust зеркалит числа, `sync-check` их пиннит.
- Ключи и роли: `docs/06` §2.5 (Squads 3/5 + 48 ч timelock для chip_core/staking, 2/5 для market/arena, горячий pauser 1/3, четыре кипер-ключа с ограниченными правами).

### 3.1 Findings нашего внутреннего ревью (все с исправлениями в коде)

| ID | Severity | Суть | Где исправлено | Статус |
|---|---|---|---|---|
| SEC-C1 | Critical | randomness-аккаунт не проверялся на владельца → поддельный VRF | `randomness.rs` (`SB_PROGRAM_ID` по cluster feature, `owner =` constraint во всех 6 местах) | ⚠ не собрано; T-L-C10/F06/A05 |
| SEC-C2 | Critical | бандлы qty ≥ 2 нельзя было довскрыть (Switchboard `get_value` только в слот reveal) | `PendingPack.revealed/value` (159 байт), первый `open_pack` фиксирует значение | ⚠ не собрано; T-L-C08/C09 |
| SEC-C3 | Critical | бесплатные re-roll через «подглядывание» (`STALE = 300` слотов, authority игрока) | `STALE_PACK_SLOTS = 10 800`, отмена только при `reveal_slot == 0`, authority = PDA `rng_auth` + CPI commit/reveal/close | ⚠ не собрано; T-L-C17..C20; T-D-04 |
| SEC-H1 | High | неверный program id Switchboard для devnet | cluster-aware константы, `sync-check` | ⚠ не собрано |
| SEC-H2 | High | пауза за 48-часовым timelock | роль `pauser` ×3 программы (`pause()` только в `true`) | ⚠ не собрано; T-L-G03b |
| SEC-H3 | High | нет rate-limit в API | `backend/src/ratelimit.ts` | ✅ тесты |
| SEC-M1 | Medium | `report_burn` никто не вызывал → эмиссия навсегда на 30 % | `EmissionState.burn_oracle`, clamp 3 × cap, кипер `burn-oracle.ts` | ⚠ не собрано; T-L-S05 |
| SEC-M2 | Medium | Pyth без conf-guard | `PYTH_MAX_CONF_BPS = 200`, цена − conf, `PriceUncertain` | ⚠ не собрано (EMA для SKR — отложено, принят риск: тонкий фид + ±2 % guard + 1 % slippage) |
| SEC-M3 | Medium | fusion fee сгорала на коммите, при stale не возвращалась | `PendingFusion.fee_escrowed`, burn в `fuse_reveal`, refund в `cancel_stale_fusion` | ⚠ не собрано; T-L-F04/F07/F08 |
| SEC-M4 | Medium | SIWS-домен из `x-forwarded-host` | allowlist `SIWS_DOMAINS`, fail-fast конфиг | ✅ тесты |
| SEC-M5 | Medium | ценность выдавалась на `confirmed` | `finality.ts` (реконсилер, eviction + rebuild, `payment_pending`) | ✅ тесты |
| SEC-M6/M7, L1–L3 | — | роялти (уже было), рента Switchboard (crank закрывает), семантика `set_chip_flag`, арена без freeze (принято), `RENT_RESERVE` 0.008 | см. docs/06 | закрыто / ⚠ M7 close_lut — #23 |
| SEC-L5 | Low | 20 % рейка копится в `season_pool` ATA, у staking нет инструкции его тратить (сезонные корни минтят из slice) | вариант (б): `staking::fund_slice(3, amount)` — burn из `ata(cg, ["season_pool"])` → `slice_budget[3]`, `recycled_total`; kind-3 `claim_root` минтит из `recycled_*` вне расписания; reward-oracle вызывает перед kind-3 корнем | ✅ код + тесты (Rust не компилировался) — **просим аудитора проверить**: (1) `recycled_minted ≤ recycled_total` ⇒ нейтральность supply; (2) PDA `["season_pool"]` ≠ vault стейкеров; (3) `fund_slice` не пишет в burn-ring |

Полные описания с атакующим сценарием и патчами — `docs/06` §2.2.

---

## 4. Известные проблемы и то, чего мы сами не проверили

### 4.1 ⚠ Rust никогда не компилировался
Все четыре программы + `sb_mock` написаны и многократно перечитаны, но **ни разу не собирались**. Реалистичные ожидания: ошибки borrow checker в `fusion.rs` (remaining_accounts × `Account::try_from` + `exit`), lifetimes в `randomness.rs` CPI-хелперах, `InitSpace` для массивов, feature-флаги `switchboard-on-demand/devnet`, версии `mpl-core 0.12.1` ↔ `anchor 0.31.1`. Это не security-findings, но аудитор столкнётся с ними первым — просим отдельно перечислить всё, что пришлось менять для сборки (дифф войдёт в §6).

### 4.2 Коды ошибок Anchor в спеках
Localnet-спеки местами ожидают `ConstraintHasOne (2001)` / `ConstraintRaw (2003)`, тогда как `has_one = x @ Err::Unauthorized` / `constraint = … @ Err::X` дают кастомный код (6000+). После первой сборки часть ассертов в `tests/localnet/*.spec.ts` надо будет поправить на реальные коды — это ожидаемое расхождение, не баг программ.

### 4.3 Открытые пункты бэклога, влияющие на аудит (`docs/06` §6)
| # | Что | Риск для аудита |
|---|---|---|
| #23 | `randomness_close_lut` (возврат ренты LUT ≈ 0.0015 SOL после cooldown) не реализован: метас инструкции отсутствуют во всех копиях IDL Switchboard, нужен `anchor idl fetch SBond…` на devnet | только unit-economics (утечка ренты), не безопасность |
| ~~#12~~ | ~~`VaultLedger` без шардирования~~ — **закрыто**: 4 шарда `["ledger", shard]`, `config` read-only в игровых ix (см. `docs/06` §4.2) | — (проверить `VaultLedger::totals` и writable-проверку на последнем паке) |
| T-D-03 | фактическая рента chip-аккаунтов не измерена (`RENT_RESERVE_PER_CHIP = 0.008 SOL` — оценка ×1.3) | недобор резерва → `sweep_vault` может забрать ренту; проверить на devnet |
| T-D-04 | CPI `randomness_reveal` от `rng_auth` не проверен на devnet (Switchboard может требовать подпись именно keypair'а) | если CPI-путь не работает, SEC-C3 часть 2 нужно переделать на authority-transfer — **это блокер G-1**, просим проверить первым |

### 4.4 Принятые риски (письменно, владелец 2026-09-15)
- Казначейский SKR-кошелёк `HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho` — single-signer, не Squads (до запуска — аппаратный, затем миграция).
- Арена не замораживает фишки на время wager-битвы (SEC-L2): отряд снапшотится, продажа фишки во время боя не меняет исход.
- Серверно-авторитетный ранкед без ставок: сервер выбирает пары, но не сид (commit–reveal + опубликованный секрет сезона); деньги в ранкеде не участвуют, награды идут через бюджетированные корни.
- Pyth SKR-фид тонкий: ±2 % conf-guard + 1 % slippage + charge at `price − conf`; EMA отложена.

---

## 5. Ключи, окружение, доступы для аудитора

| Что | Как получить |
|---|---|
| Devnet-деплой | после G-0 tech lead деплоит 4 программы с теми же id (`anchor deploy --provider.cluster devnet`), публикует `solana-verify` хэши в этом файле |
| Тестовые SKR/USDC на devnet | `scripts/skr-pool.ts test-mint`, `scripts/setup.ts` (создаёт mints и config) |
| Оракульные ключи devnet | выдаёт tech lead (отдельные ключи от прод); аудитор получает `battle_oracle` и `quest_oracle` devnet-ключи для проверки, что они не могут выйти за on-chain лимиты |
| Логи бэкенда devnet | `GET /v1/health` (crank, finality, burn-oracle, reward-oracle, arena), доступ к БД по запросу |
| Контакты | tech lead (владелец репозитория) — канал ниже |

Прод-ключи, Squads-мультисиги и Hermes API-ключ аудитору **не передаются**; для проверки процедур — `docs/06` §2.5 и runbook.

---

## 6. Канал findings и SLA

- **Канал:** приватный GitHub Security Advisory в `Leo88q/caps` (или приватный репозиторий-зеркало по запросу аудитора) — один advisory на finding, шаблон: `ID · Severity (Critical/High/Medium/Low/Info) · Программа/файл:строка · PoC (tx-лог или localnet-спек) · Impact · Recommendation`.
- **SLA ответа:** подтверждение получения ≤ 1 рабочего дня; триаж и план исправления ≤ **2 рабочих дней**; Critical/High — фикс + тест ≤ 5 рабочих дней, Medium — до G-2, Low/Info — бэклог с решением «исправить / принять риск» письменно.
- **Что мы отдаём в ответ на каждый finding:** коммит с фиксом, тест (localnet-спек или `#[test]`), строка в §3.1 этого документа и в `docs/06` §2.2.
- **Ре-аудит:** после закрытия всех Critical/High — дифф-ревью от frozen commit до нового тега `audit-v1-fix-<n>`; выход — G-4 в `docs/06` §1.4 (все High/Critical закрыты, Medium закрыты или принят риск письменно).
- **Раскрытие:** отчёт публикуется после G-4 вместе с `solana-verify` хэшами; bug-bounty (Immunefi-стиль, до 10 % от риска, cap $50 k) открывается на mainnet.

---

## 7. Чек-лист первого дня аудитора

1. `npm run verify` зелёный → окружение работает.
2. `anchor build` → список правок компиляции (в §6 как первый дифф).
3. `cargo test --workspace` → golden-векторы (odds/pity/fusion/merkle) совпадают с `packages/economy`.
4. Localnet `npm test` → сколько из 77 зелёные; расхождения кодов ошибок (§4.2) отделить от реальных багов.
5. T-D-04 на devnet: `init_randomness` + `commit` CPI от `rng_auth`, затем `reveal` через gateway и CPI — работает ли путь SEC-C3 ч. 2.
6. Пройти `docs/06` §2.3 построчно; особое внимание: `VaultLedger` (4 шарда `["ledger", shard]`, Σ `liab_*` ≤ баланс vault; `open_pack` пишет шард только на последнем паке, `sweep_vault` требует все 4 в порядке), `mint_to_user` (единственный mint-путь), `publish_root` (`budget ≤ slice_budget`), `resolve_battle` (`winner_cg.owner == winner`, дневной cap), `fuse` (`remaining_accounts` layout, `is_free`, эскроу), `open_pack` (пути `revealed`, pity, floors, бандлы), `set_chip_flag` (кто может звать, `expected_owner`).
7. Проверить, что ни один кипер-ключ (crank / burn / quest / season / battle) не может извлечь ценность сверх on-chain ограничителей (§1.2, `docs/06` §2.5).
