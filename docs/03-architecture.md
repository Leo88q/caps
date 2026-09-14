# GUTTERCAPS — Техническая архитектура

> Фазы 2–3 · v1.0 · Смарт-контракты (Anchor 0.31.1 / Rust 1.89), бэкенд, БД, API.
> Код программ — `programs/*`, схема БД — `backend/prisma/schema.prisma`, OpenAPI — `backend/openapi.yaml`.

---

## 1. Общая картина

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Клиенты: Web (Vite/React) · Telegram Mini App · Android (Solana dApp Store)    │
│           Wallet Adapter (Phantom/Solflare/Backpack) · MWA · Telegram embedded  │
└───────────────┬──────────────────────────────────────────┬─────────────────────┘
                │ RPC (tx)                                  │ HTTPS / WS (read)
                ▼                                           ▼
┌──────────────────────────────┐              ┌──────────────────────────────────┐
│ Solana                       │  events/logs │ Backend (Node 22 / TypeScript)   │
│  chip_core   packs/fusion/   │─────────────▶│  indexer  ── Postgres ── api     │
│              registry        │  Geyser/ WS  │  matchmaker/arena  ── Redis      │
│  market      escrow          │              │  quests-oracle · season-oracle   │
│  staking     $CG emission    │◀─────────────│  cranks (open_pack, thaw, payout)│
│  arena       wager/claims    │  oracle tx   │  admin panel (economy params)    │
│  Switchboard On-Demand · Metaplex Core · Pyth SOL/USD                          │
└──────────────────────────────┘              └──────────────────────────────────┘
```

**Принцип разделения:** всё, что меняет владение/деньги — on-chain и permissionless-проверяемо; всё, что требует реального времени, приватности или тяжёлых вычислений (матчмейкинг, бой, агрегаты, антифрод) — off-chain, но с **публикуемыми доказательствами** (сид сезона, Merkle-корни выплат, события).

---

## 2. Смарт-контракты

### 2.1 Почему 4 программы, а не одна
Текущий `chip-game` — монолит. Разделяем по причине **upgrade blast radius и лимита размера**: маркет и арену обновляем чаще, чем реестр фишек; компрометация upgrade-ключа маркета не должна давать доступ к mint authority $CG. Общий тип `ChipState` живёт в `chip_core`, остальные читают его через `Account<'info, ChipState>` c `owner = chip_core::ID`.

| Программа | Ответственность | Upgrade authority |
|---|---|---|
| `chip_core` | реестр коллекций (Core Collections), паки (VRF), fusion, ChipState, soulbound-локи, pity | Squads 3/5, timelock 48 ч |
| `market` | листинги (freeze-in-place), покупка, офферы, комиссии | Squads 2/5 |
| `staking` | $CG mint authority (EmissionState), token-staking, chip-staking, activity-guard, quest/season payouts через Merkle | Squads 3/5, timelock 48 ч |
| `arena` | wager-эскроу, резолв оракулом, сезонный claim | Squads 2/5 |

### 2.2 NFT-стандарт: Metaplex Core

Решение — **Core, не Bubblegum и не Token Metadata**:
- Core: 1 аккаунт на фишку, ~0.0037 SOL/минт (vs 0.022 у TM). 1 M фишек = 3 700 SOL rent, оплачивается покупателем в цене пака (≈ $0.5 при $135/SOL — заложено в маржу).
- Плагины дают нам ровно то, что нужно: `PermanentFreezeDelegate` (стейк/листинг/soulbound без перемещения), `PermanentBurnDelegate` (fusion сжигает без подписи владельца на каждый материал — подпись одна на tx), `Royalties` (2.5 % enforced), `Attributes` (rarity/collection/index on-chain — маркеты Tensor/ME читают их).
- Bubblegum (cNFT) дешевле, но: burn/freeze требуют Merkle-proof'ов в каждой tx (fusion 3 материала = 3 proof'а ≈ лимит tx), нет enforced royalties, хуже поддержка в кошельках. При объёмах < 10 M фишек Core выигрывает по сумме.

`ChipState` (наш PDA) остаётся отдельно от ассета: игровое состояние меняется часто, метаданные — никогда (кроме reveal через `Attributes`).

### 2.3 PDA-схема

| Аккаунт | Программа | Seeds | Размер | Назначение |
|---|---|---|---|---|
| `GameConfig` | chip_core | `["config"]` | 8+~200 | admin, treasury, cg_mint, oracle-ключи, paused, fee-параметры, pack SKU (4 × PackSku) |
| `CollectionMeta` | chip_core | `["collection", u8 idx]` | 8+~80 | ссылка на Core Collection, symbol, element, minted counter |
| `ChipState` | chip_core | `["chip", asset]` | 8+~72 | rarity, level, collection_idx, index, flags(staked/listed), lock_until, stake_pool_debt |
| `PendingPack` | chip_core | `["pending", buyer, nonce u64]` | 8+~120 | sku, qty, randomness_account, commit_slot, paid, pity_snapshot |
| `PlayerPity` | chip_core | `["pity", wallet]` | 8+16 | counters std/premium/limited |
| `Vault` (system) | chip_core | `["vault"]` | 0 | SOL от продаж + authority USDC/$CG ATA; **никогда не опускается ниже `liab_*`** (refund-обязательства по нераскрытым пакам) |
| Core Asset | chip_core | `["asset", pending, pack_no u8, slot u8]` | Core | адрес фишки детерминирован → crank-retry не может сминтить дважды; для fusion: `["asset", pending_fusion, 0, 0]` |
| `PlayerItems` | chip_core | `["items", wallet]` | 8+35 | бустеры (непередаваемые) |
| `ChipStake` | staking | `["cstake", asset]` | 8+~100 | weight, reward_debt по одной фишке |
| `ArenaConfig` | arena | `["arena_config"]` | 8+~152 | oracle, season_pool ATA, treasury_cg ATA (40 % rake), **oracle_daily_cap** (circuit breaker) |
| PDA-подписанты | все | `["market_auth"]`, `["stake_auth"]`, `["arena_auth"]`, `["burn_reporter"]`, `["rewarder"]` | 0 | межпрограммная аутентификация по hard-coded program id, без конфигурируемых allowlist'ов |
| `PendingFusion` | chip_core | `["fusion", owner, nonce]` | 8+~140 | recipe, 3 материала, randomness, commit_slot, booster |
| `Listing` | market | `["listing", asset]` | 8+~90 | seller, price, currency (0 SOL / 1 USDC / 3 SKR), created_at |
| `ServiceLedger` | chip_core | `["services", wallet]` | 8+65 | дневные счётчики платных сервисов (`bought_today[16]`, `day_start`), `spent_usd_cents_total` |
| `Offer` | market | `["offer", asset, bidder]` | 8+~80 | amount USDC в эскроу-ATA, expiry |
| `EmissionState` | staking | `["emission"]` | 8+~200 | cap schedule, minted_total, day_index, burn ring[7], split bps, mint authority |
| `TokenPool` | staking | `["token_pool"]` | 8+~80 | total_weight, acc_reward_per_weight (u128), last_update |
| `TokenStake` | staking | `["tstake", wallet, u8 tier]` | 8+~80 | amount, weight, reward_debt, unlock_at |
| `ChipPool` | staking | `["chip_pool"]` | 8+~80 | total_weight, acc_reward_per_weight |
| `SetBonus` | staking | `["setbonus", wallet]` | 8+16 | completed_sets, updated_at (oracle-signed) |
| `RewardRoot` | staking | `["root", u8 kind, u32 epoch]` | 8+~60 | Merkle root выплат (quests/season), budget, claimed_bitmap ptr |
| `ClaimReceipt` | staking | `["claim", root, wallet]` | 8+1 | защита от двойного клейма |
| `SkrPool` | staking | `["skr_pool"]` | 8+107 | SKR-призовой пул (наградная валюта #2): `skr_mint`, `vault` (ATA пула), `budget`, `reserved`, `funded_total`, `paid_total`, `max_root_budget`, `paused`; инвариант `vault ≥ budget + reserved` |
| `WagerBattle` | arena | `["battle", challenger, nonce]` | 8+~200 | стороны, ставка ($CG ATA-эскроу), squads[3], randomness, status |

Все PDA хранят `bump`; все `init` — с явным `space`; все числовые операции — `checked_*`.

### 2.3½ Статус реализации
Код четырёх программ лежит в `programs/{chip_core,market,staking,arena}` (Anchor 0.31.1, mpl-core 0.12.1, switchboard-on-demand 0.13.0, pyth-solana-receiver-sdk 1.0.1). **Не компилировался** — в среде разработки не было Rust/Anchor toolchain'а и доступа к crates.io; см. `programs/README.md` («Status») о том, что ожидать на первом `anchor build`. Все экономические константы в Rust сверяются с `packages/economy` скриптом `npm run economy:check` (текстовый diff + 64 golden-вектора VRF-раскрытия, которые `cargo test -p chip_core --test golden` прогоняет через on-chain `expand`).

### 2.4 Инструкции по программам

#### chip_core
| Инструкция | Подписант | Суть |
|---|---|---|
| `initialize(config)` | admin | создать GameConfig, назначить оракулов |
| `set_params(params)` | admin | цены SKU, odds, pity, paused, fee; **odds валидируются: Σ = 10 000, Legend+/Diamond ≤ cap** |
| `create_collection(idx, name, uri, element)` | admin | Core Collection с плагинами Royalties(250 bps), PermanentFreeze, PermanentBurn (authority = CollectionMeta PDA) |
| `buy_pack(sku, qty, currency, nonce, max_lamports)` | buyer | оплата **в vault PDA** (currency 0 SOL по Pyth SOL/USD ≤ 60 с + slippage-guard / 1 USDC / 2 $CG / 3 SKR по Pyth SKR/USD с промо `skr_discount_bps`; SPL-нога generic: `buyer_token`/`vault_token`, mint сверяется с currency), rent-резерв 0.006 SOL × фишка в PendingPack, Switchboard commit-проверка (`seed_slot == slot−1`, `!revealed`), init PendingPack, pity snapshot, daily cap / starter 1-на-кошелёк |
| `open_pack(nonce, pack_no)` | anyone | `get_value(slot)` → sub-seed `keccak(value‖pack_no)` для бандлов → `expand` → N × `CreateV2` (asset = PDA) + ChipState; pity update; rent cranker'у из резерва; на последнем паке — burn 75 % $CG / 25 % treasury и close; `PackOpened` |
| `cancel_stale_pack(nonce)` | buyer | если `slot − commit_slot > 300` и **не раскрыто** → 100 % refund из vault в любой валюте (без админа и без off-chain keeper'а) |
| `sweep_vault()` | admin | перевести выручку в treasury, но не ниже `liab_*` (SOL-нога + одна SPL-нога за вызов: USDC или SKR) |
| `pay_service(kind, currency, max_units, ref_hash)` | buyer | платный сервис (`economy::ServiceKind` 0–9): $CG → burn (+`BurnReported{source:3}`), SOL/USDC/SKR → treasury; per-kind дневной кап в `ServiceLedger`; бустер → `PlayerItems.boosters`; событие `ServicePaid{buyer,kind,currency,amount,burned,ref_hash}` — backend биндит к payload (handle/skin/theme) по `ref_hash = keccak(0x00‖kind‖wallet‖payload)` |
| `fuse(nonce, use_booster)` + 3 материала в remaining_accounts | owner | рецепт выводится из редкости материалов; fee burn 100 %; 100 %-рецепты: одна tx (burn 3 → mint 1); < 100 %: freeze материалов (`F_FUSING`) + PendingFusion + commit |
| `fuse_reveal(nonce)` | anyone | reveal → success? burn 3 + mint : burn 2 + вернуть 1 (детерминированно — наименьший asset key; unfreeze); `ChipFused` |
| `cancel_stale_fusion(nonce)` | owner | только при отказе оракула: unfreeze материалов, fee не возвращается |
| `thaw_chip(asset)` | owner | снять soulbound/result-lock после `lock_until` |
| `set_chip_flag(flag, set, expected_owner)` | CPI: market_auth / stake_auth | LISTED/STAKED ⇄ Core PermanentFreeze; проверяет владельца Core-ассета |
| `deliver_sold(expected_seller)` | CPI: market_auth | только для `F_LISTED`: unfreeze + `TransferV1` через PermanentTransferDelegate покупателю |
| `level_up(levels)` | CPI: arena_auth | XP из сезонных Merkle-корней; cap по редкости |
| `grant_booster(count)` | admin / rewarder PDA | бустеры за квесты; никогда не продаются |
| `set_paused`, `propose_admin` / `accept_admin` | admin | kill-switch; 2-step передача админа |

#### market
| Инструкция | Подписант | Суть |
|---|---|---|
| `list(asset, price, currency)` | owner | freeze (PermanentFreezeDelegate CPI через chip_core `set_flag`), init Listing, listing fee 0.5 $CG burn |
| `update_price(asset, price)` | seller | |
| `cancel(asset)` | seller | unfreeze, close |
| `buy(asset)` | buyer | оплата: 90 % seller, fee `GameConfig.market_fee_bps` (default 7.5 %, cap 10 %; ⅓ buyback-burn wallet / ⅔ treasury), 2.5 % royalty; SOL — system transfers, USDC/SKR — generic `*_token` ATA (mint = listing.currency); unfreeze; `TransferV1` к покупателю; `ChipSold` |
| `make_offer(asset, amount, expiry)` / `accept_offer` / `cancel_offer` | bidder / seller | USDC-эскроу |

#### staking
| Инструкция | Подписант | Суть |
|---|---|---|
| `init_emission(schedule, split)` | admin | один раз; передать mint authority $CG на EmissionState |
| `set_split(bps[5])` | admin | ±10 п. п. от предыдущего, не чаще раза в 7 дней |
| `tick_day()` | anyone (crank) | закрыть день: `today_cap = guard(schedule, burn_ring)`, распределить по пулам |
| `stake_cg(amount, tier)` / `unstake_cg(tier)` / `claim_cg(tier)` | user | MasterChef; ранний выход — штраф burn |
| `stake_chip(asset)` / `unstake_chip` / `claim_chip` | owner | вес из ChipState × SetBonus; freeze/unfreeze через chip_core |
| `sync_set_bonus(wallet, sets, sig)` | set-oracle | обновить SetBonus (индексатор доказал 9/9) |
| `publish_root(kind, epoch, root, budget)` | quest/season-oracle | kind 2–4 ($CG): бюджет ≤ остаток слайса; timelock 1 ч на оспаривание |
| `claim_root(kind, epoch, amount, proof)` | user | mint $CG ≤ budget; ClaimReceipt; kind ≥ 5 → `WrongRootCurrency` |
| `report_burn(amount)` | CPI only (chip_core, market, arena) | инкремент кольцевого буфера дня |
| `init_skr_pool(max_root_budget)` | admin | один раз; vault = token account с authority `["skr_pool"]`; 0 → кап 100 000 SKR |
| `fund_skr(amount)` | anyone (казна еженедельно) | `transfer` в vault, `budget += amount`; `SkrFunded` |
| `sync_skr_pool()` | anyone | зачесть SKR, присланный в vault напрямую (`vault − budget − reserved → budget`) |
| `withdraw_skr(amount)` / `set_skr_pool(max?, paused?)` | admin | забрать только незарезервированный `budget`; кап на корень / пауза |
| `publish_skr_root(kind 5–7, epoch, root, budget)` | quest-oracle (5) / season-oracle (6, 7) | `budget ≤ min(pool.budget, max_root_budget)`; `budget → reserved`; тот же `["root", kind, epoch]` |
| `claim_skr_root(amount, proof)` | user | `transfer` из vault от PDA пула (ничего не минтится); `reserved −= amount`; ClaimReceipt; kind < 5 → `WrongRootCurrency` |
| `revoke_skr_root()` | admin | невыбранный остаток `reserved → budget` |

#### arena
| Инструкция | Подписант | Суть |
|---|---|---|
| `create_battle(wager, squad[3], nonce)` | challenger | $CG в эскроу-ATA PDA; фишки проверяются на владение и `!listed`; Switchboard commit |
| `accept_battle(squad[3])` | opponent | ставка в эскроу; status → AwaitingResolution |
| `resolve_battle(winner, result_hash)` | battle-oracle | `winner ∈ {challenger, opponent}`; rake 5 % → 20 % season pool ATA, 40 % treasury_cg ATA, 40 % burn; payout; **daily payout cap на оракула** |
| `cancel_stale_battle` | either | нет оппонента 10 мин / нет резолва 30 мин → refund |

### 2.5 Поток «пак» (commit-reveal, Switchboard On-Demand 0.13)

```rust
// buy_pack — фрагмент
let rnd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())?;
require!(rnd.seed_slot == clock.slot - 1, ChipError::RandomnessExpired);       // свежий commit
require!(rnd.get_value(clock.slot).is_err(), ChipError::RandomnessAlreadyRevealed); // нельзя подсунуть раскрытый
take_payment(...)?;                                                             // ДЕНЬГИ НА COMMIT, не на reveal
pending.randomness = ctx.accounts.randomness.key(); pending.commit_slot = rnd.seed_slot;

// open_pack
require_keys_eq!(ctx.accounts.randomness.key(), pending.randomness);
let rnd = RandomnessAccountData::parse(...)?;
require!(rnd.seed_slot == pending.commit_slot, ChipError::RandomnessExpired);
let bytes = rnd.get_value(clock.slot).map_err(|_| ChipError::RandomnessNotResolved)?;
let slots = expand(&bytes, sku, pity_snapshot, pool_len);                        // детерминированно, см. economy/packs.ts
```
Оплата на commit закрывает «selective reveal» (не раскрывать проигрышный результат). `cancel_stale_pack` — единственный выход без reveal, и он возвращает деньги, а не выдаёт фишки.

**Реализация (programs/chip_core/src/instructions/packs.rs):** деньги идут не в treasury, а в программный `["vault"]` PDA; `GameConfig.liab_lamports/usdc/cg` учитывает обязательства по всем нераскрытым пакам, `sweep_vault` не может увести vault ниже этой суммы. Поэтому refund при отказе оракула — полностью on-chain и не зависит от Squads-подписей. $CG-оплата тоже держится в vault до reveal, burn 75 % происходит на последнем `open_pack` — иначе отменённый пак сжигал бы деньги игрока.

### 2.6 События (`emit!`)
`PackBought{buyer,sku,qty,currency,amount}` · `PackOpened{buyer,sku,assets[],rarities[],roll_bytes}` · `ChipFused{owner,recipe,materials[3],result,success,roll}` · `ChipListed/ChipDelisted/ChipSold/OfferMade/OfferAccepted` · `CgStaked/CgUnstaked/CgClaimed{tier}` · `ChipStaked/ChipUnstaked/ChipRewardClaimed` · `DayTicked{day,cap,guarded,burn7d}` · `RootPublished/RootRevoked/RootClaimed` (kind ≥ 5 ⇒ SKR) · `SkrFunded{funder,amount,budget,reserved}` · `SkrWithdrawn{to,amount,budget}` · `SkrPoolChanged{max_root_budget,paused}` · `BattleCreated/Accepted/Resolved{winner,payout,rake,rake_treasury,result_hash}` · `BurnReported{source,amount}` · `ServicePaid{buyer,kind,currency,amount,burned,ref_hash}`.
Индексатор строится **только** на них + на изменениях аккаунтов (Geyser/Helius webhooks) для консистентности.

### 2.7 Security-чеклист по программам

| Класс | Мера | Где |
|---|---|---|
| Подпись/владение | `Signer` на все действия владельца; владение Core-ассетом через `BaseAssetV1.owner == signer`; PDA через `seeds+bump` | все |
| Overflow | `checked_*`/`saturating_*` везде; u128 для аккумуляторов; `overflow-checks = true` в профиле release | все |
| Реентерабельность через CPI | нет callback'ов в наши программы из внешних; CPI только в Core/Token/Switchboard/System; состояние обновляется **до** CPI (CEI) | все |
| Front-running паков | оплата на commit; `seed_slot == slot−1`; `!revealed` на commit; randomness account хранится в PendingPack | chip_core |
| Манипуляция VRF | значение = TEE-подпись Switchboard, детерминировано от commit; используем все 32 байта; rejection sampling вместо `mod` | chip_core |
| Mint/burn authority $CG | authority = EmissionState PDA; mint возможен только в `tick_day`-бюджете; admin = Squads 3/5 + timelock | staking |
| Oracle-ключи | battle-oracle: выплата только сторонам матча + дневной cap; quest/season-oracle: только Merkle-корни в пределах бюджета + timelock на claim; set-oracle: только SetBonus | arena/staking |
| Замороженные ассеты | все переходы состояния проверяют `flags`: нельзя list staked, fuse listed, stake locked | chip_core |
| Пауза | `paused` блокирует buy/list/stake/create_battle, не блокирует cancel/unstake/claim | все |
| Rent-drain | все `close =` возвращают rent инициатору; PendingPack/PendingFusion закрываются в reveal/cancel | chip_core |
| Admin-параметры | odds Σ = 10 000; Legend+Diamond ≤ 200 bps на Standard; fee ≤ 1 000 bps; split Δ ≤ 1 000 bps | chip_core/staking |

### 2.8 Compute units и стоимость (оценка)

| Транзакция | CU (оценка) | Аккаунтов | Комментарий |
|---|---|---|---|
| `buy_pack` (SOL) | ~45 k | 9 | Pyth read + transfer + PendingPack init |
| `open_pack` ×3 фишки | ~210 k | ~14 | 3 × CreateV2 (~55 k каждый) + 3 ChipState init |
| `open_pack` ×5 фишек | ~340 k | ~18 | Premium/Limited — одна tx, < 1.4 M лимита; запрашиваем `set_compute_unit_limit(400_000)` |
| `fuse` 100 % | ~190 k | 12 | 3 × BurnV1 + CreateV2 + burn $CG |
| `buy` (market) | ~80 k | 12 | 3 transfer + unfreeze + TransferV1 |
| `stake_cg`/`claim_cg` | ~30 k | 7 | |
| `resolve_battle` | ~50 k | 9 | |

Пиковая нагрузка ивента: цель 500 паков/мин (≈ 8 tx/с open_pack). Solana держит; узкое место — Switchboard reveal latency (~1–2 с) и наш crank. Crank — горизонтально масштабируемые воркеры, each pulls PendingPack из очереди Redis, приоритет FIFO по `commit_slot`. Приоритетные комиссии: динамические, cap 0.001 SOL.

---

## 3. Бэкенд

### 3.1 Сервисы (monorepo `backend/`)

| Сервис | Стек | Ответственность |
|---|---|---|
| `indexer` (`backend/src/{events,ingest,backfill,listen,projections}.ts`) | Node 22, Helius webhooks (primary) + WS `onLogs` (fallback) + backfill `getSignaturesForAddress` + gap-healer каждые 60 с | декодирует 30 событий 4 программ **без IDL** (дискриминатор `sha256("event:Name")[..8]` + декларативная Borsh-схема, CPI-атрибуция по стеку invoke/success) → `events_raw` → проекции: инвентарь, листинги, floor, продажи, стейки, батлы, burns, `service_payments`; идемпотентность по `(signature, ix_index, event_index)`, проекция применяется только при фактической вставке; `npm run rebuild` пересобирает проекции из лога |
| `api` | Fastify + Zod + OpenAPI 3.1 | REST для клиента; JWT по SIWS (Sign-In-With-Solana); rate-limit Redis |
| `arena` | Fastify + ws; воркер BullMQ | очередь, матчмейкинг Glicko-lite, детерминированный fight-engine (тот же код, что `packages/economy/pvp.ts`), commit-reveal сида, античит, вызов `resolve_battle` для wager-матчей |
| `oracles` | воркеры BullMQ | quest-oracle (Merkle-корни раз в час), season-oracle (по завершении сезона), set-oracle (`sync_set_bonus`), thaw-crank, open_pack-crank, buyback-bot (еженедельно) |
| `admin` | Next.js (internal) + api `/admin/*` с ролями | параметры экономики, ивенты, фичефлаги, дашборд KPI, kill-switch (paused) |
| `analytics` | Postgres → ClickHouse (позже) + Metabase | KPI из PRD |

### 3.2 Схема данных (Postgres) — ключевые таблицы
См. `backend/prisma/schema.prisma`. Кратко:

- `wallets(address PK, first_seen, referrer, flags jsonb, risk_score)`
- `chips(asset PK, owner, collection_idx, rarity, level, index_no, flags, lock_until, updated_slot)` — проекция ChipState + owner из Core
- `listings(asset PK, seller, price, currency, created_at, cancelled_at, sold_at)`
- `sales(id, asset, seller, buyer, price, currency, fee, royalty, signature, slot)`
- `floor_snapshots(collection_idx, rarity, ts, floor, listed_count)` — каждые 5 мин
- `pack_opens(signature, buyer, sku, rarities int[], roll_bytes bytea, pity_before, slot)`
- `fusions(signature, owner, recipe, materials text[], result, success, roll)`
- `stakes_cg(wallet, tier, amount, weight, since, unlock_at)` · `stakes_chip(asset, wallet, since)`
- `matches(id, season, a, b, squads jsonb, seed_commit_a, seed_commit_b, seed, result jsonb, winner, wager, signature)`
- `ratings(wallet, season, rating, rd, games, league)`
- `quest_progress(wallet, quest_id, period_key, value, completed_at, claimed_at)`
- `reward_roots(kind, epoch, root, budget, leaves jsonb, published_sig)` · `reward_claims(root_id, wallet, amount, signature)`
- `events_raw(signature, ix_index, event_index, program, name, data jsonb, slot, block_time)` — источник правды для реплея
- `economy_params(key, value jsonb, version, changed_by, changed_at)` — история изменений админки
- `fraud_signals(wallet, kind, score, evidence jsonb, ts)`

Redis: очереди BullMQ (`open-pack`, `thaw`, `quest-roots`), матчмейкинг (sorted set по рейтингу на лигу), rate-limits, кэш `GET /market/floor`, pub/sub для WS.

### 3.3 API
`backend/openapi.yaml` — 3.1. Основные группы: `/auth/siws`, `/me/*` (инвентарь, стейки, квесты, pity), `/packs/*` (каталог с текущими odds, `POST /packs/quote` → цена в SOL по Pyth + tx-параметры), `/market/*` (листинги с фильтрами, floor, история), `/arena/*` (queue, match, seasons, leaderboard), `/quests/*`, `/staking/*` (APY-оценка из on-chain TVL), `/collections/*` (лор, арт, минт-статистика), `/admin/*`.

**Реализовано в `backend/` (dev-стек: express + `node:sqlite`, без нативных модулей):** SIWS-сессии (HttpOnly cookie + CSRF), `/me*`, `/services*` и `/me/handle*` (валидация `ServicePaid.ref_hash`, единоразовое потребление платежа, карантин/кулдаун хэндлов), `/packs`, `/packs/opens/{sig}`, `/packs/verify`, `/collections`, `/chips/{asset}`, `/market/*`, `/leaderboard/{board}`, legacy `/stats`. Эндпоинты арены, квестов, стейкинга и `/packs/quote` отвечают `501` до появления соответствующих воркеров — клиент на них per-request переключается на mock. См. `backend/README.md`.

### 3.4 Античит / антифрод
- **PvP:** серверный расчёт; клиент присылает только состав и commit; повторные матчи с одним оппонентом > 3/день — без наград; win-trading детектор (граф пар с win-rate > 80 % и низким рейтинг-разбросом); длительность < 20 с → без наград.
- **Квесты:** прогресс только из on-chain событий и серверных матчей; клейм через Merkle с оракульным бюджетом; Turnstile; device fingerprint (FingerprintJS OSS) + IP /24 rate-limit; кошельки моложе 24 ч без платного пака → квесты видны, но клейм отложен.
- **Маркет:** wash-trading детектор (одна и та же пара кошельков, цена ≫ floor) → исключение из объёмных квестов/лидербордов (on-chain не блокируем — это их деньги).
- **Sybil на Starter/рефералах:** реферал засчитывается после платного пака; один Starter на fingerprint+кошелёк.

### 3.5 Админ-панель экономики «на лету»
Все параметры, вынесенные в `GameConfig`/`EmissionState` (цены SKU, odds, pity, fee, split, paused, featured collection, event windows), меняются транзакцией `set_params` через Squads (2/5) из UI админки — **без редеплоя**. Валидация инвариантов из `packages/economy` выполняется в UI до подписи и повторно в контракте. История — `economy_params` + on-chain события `ParamsChanged`.

---

## 4. Диаграмма модулей фронтенда (кратко; детали — Фаза 4)

```
client/src
  app/            providers (wallet, query, store), router, layout, nav
  features/
    packs/        PackShop, PackReveal (существующая анимация), usePackFlow (commit→crank→reveal)
    inventory/    Grid 10×9 (Collection screen), ChipCard (rim by rarity), drag-to-list
    fusion/       FusionBench (3 слота), RecipeInfo (clean-zone), useFusion
    market/       Listings + filters, ChipDetail, ListModal (clean-zone), Offers
    arena/        SquadBuilder, Queue, MatchReplay, Seasons, Leaderboard
    staking/      CgStaking (tiers, APY est.), ChipStaking, SetBonus
    quests/       Daily/Weekly/Permanent, Claim (Merkle)
    profile/      wallet, stats, referrals, settings
  shared/
    ui/           theme.css (существующая), buttons, icons, CleanZone, Modal, Toast
    lib/          program clients (4 IDL), pdas, pyth, switchboard, economy (re-export @guttercaps/economy)
    api/          typed fetch (openapi-typescript), react-query hooks
    store/        zustand: ui state (tab, modals, drag), optimistic tx state
```
Состояние: **TanStack Query** для всего серверного/он-чейн (инвентарь, листинги, стейки — с инвалидацией по WS-событиям индексатора) + **Zustand** для клиентского (навигация, драг, очередь reveal-анимаций, звук). Redux не нужен: нет сложных редьюсеров, есть много асинхронных источников.
