# Аудит безопасности по чек-листу Solana/Anchor — 2026-09-25

Область: `programs/chip_core`, `market`, `staking`, `arena` (Anchor 0.31.1, solana 2.1, rust 1.89,
`overflow-checks = true`). `programs/sb_mock` — только localnet-мок Switchboard, вне области.
Предыдущие отчёты (SECURITY-ECON-AUDIT-2026-09-21, SECURITY-SCAN-TRIAGE-2026-09-23) учтены; здесь —
только то, что проверено заново, плюс новые находки.

## Находки

| ID | Серьёзность | Пункт | Где | Суть | Статус |
|----|-------------|-------|-----|------|--------|
| SEC-F2 | **High** | 29, 19 | `chip_core/src/instructions/compressed.rs` `fuse_compressed_claims` | Нет проверки дубликатов в `remaining_accounts`: один и тот же claim, переданный 3 раза, проходил все проверки, помечался `consumed` один раз, а результат следующей редкости всё равно создавался. Рецепты 0–3 — 100 % успех без блокировки результата, поэтому один settlement-free claim (любой результат слияния или admin-staged) превращался в claim на 1–4 ступени выше (вместо 3/9/27/81 материалов). Это раздувает редкость, вес стейкинга и цену на маркете. В рандомизированном пути (`fuse_claims_commit`) и в пути через Core (`fuse` → `load_materials`) такая проверка была. | **Исправлено**: общий хелпер `ensure_distinct_material` (compressed.rs:299) вызывается в обоих путях (:709, :936) |
| SEC-F11 | **Medium** | 16, 20 (бэкенд) | `backend/src/arena.ts` `resolve` / `forfeit` | Рейтинговая арена: рейтинг против бота считался так, будто у бота рейтинг самого игрока (ожидание всегда 50 %, без возврата к среднему). Бот подбирается по on-chain силе, а в бою действует синергия (+8 % за пару одной стихии) при случайных коллекциях бота, поэтому моно-стихийный отряд выигрывает у бота ≈ 67 % (движок `resolveFight`, 20 000 боёв; смешанный отряд той же силы — 48 %). Итог — +3.4 рейтинга за бот-матч (K = 20) без потолка: ~300 бот-матчей в пустой очереди ≈ +1 000, то есть верх сезонной лестницы, которая платит реальные $CG из эмиссии (15 % пула — топ 0.1 %). | **Исправлено**: `BOT_RATING` = стартовый рейтинг (1000) для бота в `resolve` и `forfeit`; Elo против фиксированного рейтинга сходится (даже при 67 % — ≈ 1120). Тест `game.test.ts` «SEC-F11 bot farming»: 300 бот-матчей моно-отрядом → рейтинг < 1350 (до фикса — 1780) |
| SEC-F5 | **Medium** | 17 | `market/src/lib.rs` `buy_compressed`, `buy_compressed_asset` | У покупателя нет защиты по цене: продавец мог атомарно сделать `cancel_compressed` + `list_compressed` по более высокой цене раньше транзакции покупателя (или в бандле), и покупатель платил цену на момент исполнения. В legacy-`buy` защита `expected_price` уже была. | **Исправлено**: аргумент `expected_price: u64` + `MarketError::ListingPriceChanged` (lib.rs:1102, :1447); клиентские билдеры требуют `expectedPrice` |
| SEC-F1 | **Medium** | 11, 20 | `staking/src/instructions/emission.rs` `init_emission` | docs/02 обещает hard cap 1 млрд и отсутствие freeze authority, но проверялись только `decimals == 6`. К синглтону эмиссии навсегда могли привязать mint с freeze authority (её держатель может заморозить $CG любого игрока или пула) или с предварительной эмиссией сверх не-игровой доли (supply + 550 M игровой эмиссии > 1 B). | **Исправлено**: `validate_cg_mint` (emission.rs:57): `freeze_authority == None`, `supply ≤ HARD_CAP − PLAY_BUCKET` (450 M); `StakeError::BadMint` |
| SEC-F4 | Low | 20 | `compressed.rs` `stage_compressed_chip` | Единственный админ-путь, создающий claim **любой** редкости «из воздуха», не эмитил событий: действия скомпрометированного или ошибившегося админа не оставляли следа в индексере. | **Исправлено**: событие `CompressedChipStaged` (state.rs, compressed.rs:283) |
| SEC-F6 | Low | 26 | `client/src/chain/errors.ts`, `tests/localnet/helpers/expect.ts` | В таблицах ошибок market не было `InvalidTreasury`/`InvalidBuyback`: коды 6012/6013 показывались пользователю как «неизвестная ошибка». Кроме того, в `BuyCompressed`/`BuyCompressedAsset` подмена treasury/buyback отклонялась общим `ConstraintAddress` (2012) — теперь `address = … @ InvalidTreasury/InvalidBuyback`, как в legacy `Buy` (защита не менялась, только тип ошибки). | **Исправлено** + статический гейт D26 |
| SEC-F3 | Info | 15 | `staking/src/state.rs::early_exit_penalty`, `stake.rs:164` | Штраф за досрочный unstake `amount * bps / 10_000` округлялся вниз: при выводе частями ≤ 19 micro-$CG (500 bps) штраф был 0. Экономически бессмысленно (комиссия tx ≫ выгода), но это обход правила. | **Исправлено**: `⌈amount·bps/10 000⌉` в программе, клиенте (`unstakePenalty`) и бэкенде; R `early_exit_penalty_rounds_up_and_never_exceeds_principal`, L S03b |
| SEC-F7 | Info | 17, 6 | `chip_core::initialize`, `arena::init_arena`, `scripts/setup.ts` | Не было проверки upgrade authority: между деплоем и `initialize` кто угодно мог создать config со своим admin/treasury (first caller wins), а `npm run setup` при существующем config писал «exists — skip» и молча принимал чужой config вместе с его mint'ами. | **Исправлено**. On-chain: последний аккаунт обеих инструкций — ProgramData (PDA загрузчика `[program_id]`); проверяются адрес, владелец (upgradeable loader) и записанная upgrade authority == signer (`chip_core::deploy_guard`), иначе `NotUpgradeAuthority` (chip_core 6045, arena 6016). Off-chain: `scripts/init-guard.ts` — setup отказывается принять чужой config / arena / emission и заранее объясняет, почему init упадёт. Тесты: R `only_the_recorded_upgrade_authority_passes`, L `82-init-authority.spec.ts` (6 сценариев), S `init-guard.test.ts` |
| SEC-F8 | Info | 28 | `chip_core/src/instructions/rng.rs` `close_randomness` | Требовалось `pending.lamports() == 0`: перевод ≥ rent-minimum на адрес закрытого pending PDA навсегда блокировал возврат ренты Switchboard-аккаунта (~0.002 SOL) владельцу. | **Исправлено**: «закрыт» = нет данных и владелец — System program (живой pending всегда принадлежит chip_core и содержит данные; переназначить PDA может только chip_core). Тест: L `SEC-F8 lamport-donation grief` в `80-security.spec.ts` |
| SEC-F9 | Info | 20 | arena `resolve_battle` | Победителя выбирает оракул (roll только эмитится). Ограничено `oracle_daily_cap`, победитель обязан быть участником, `winner_cg.owner == winner`. Централизованное доверие — известный принятый риск (SECURITY.md). | Принято |
| SEC-F10 | Info | 28, 13 | arena `WagerBattle` | PDA битвы не закрывается никогда: ни `resolve_battle`, ни `cancel_stale_battle`, ни `close_battle_randomness` (эскроу-ATA и randomness закрываются, сам бой — нет). 8 + 402 = 410 байт → ≈ 0.0037 SOL ренты челленджера на каждый бой заморожено навсегда, а `crank.sweepChain` (`getProgramAccounts` по дискриминатору `WagerBattle`) растёт вместе со всей историей боёв. Это осознанное «надгробие»: оно делает пару (challenger, nonce) одноразовой (L A09) и держит строку `battles` в индексере уникальной (`insertIgnore` по PDA). | Принято (by design), зафиксировано тестом R-A13. Рекомендация на будущее: закрывать бой в `close_battle_randomness`, а одноразовость nonce перенести в монотонный счётчик у игрока (или ключ индексера `battle + created_sig`); sweep фильтровать по `status` через memcmp |

## Чек-лист: вердикты и доказательства

Легенда: ✅ защищено · ⚠️ было уязвимо → исправлено · ℹ️ принятый риск или рекомендация.
«Тест» — где пункт проверяется автоматически: **S** = статический гейт `tests/security/anchor-invariants.test.ts`,
**L** = LiteSVM `tests/localnet/80-security.spec.ts` / `81-emission-mint-guard.spec.ts`, **R** = Rust unit.

### A. Идентичность и аккаунты
1. **PDA-спуфинг / канонический bump** ✅ — все 50 `init`/`init_if_needed` — PDA с `seeds + bump` (канонический) или ATA; ручные PDA — через `find_program_address` с последующим `require_keys_eq` (open_compressed_pack, fuse_reveal, close_randomness). Тест: S (A1), L — побайтовая копия config по не-PDA адресу → `ConstraintSeeds`, чужой ledger-шард → `ConstraintSeeds`.
2. **Mint/owner token-аккаунтов** ✅ — каждый `TokenAccount` привязан к mint через `token::mint`/`associated_token`/`address` или `require_keys_eq!(x.mint, …)` в хендлере (packs.rs:304, :1047, :1133; compressed.rs:1585; market lib.rs:548). Тест: S (C2), L — свой ATA вместо vault → `ConstraintTokenOwner`; C03 — чужой mint → `CurrencyNotAccepted`.
3. **Signer** ✅ — все payer'ы — `mut Signer`; все пользовательские и админские роли — `Signer` + `has_one`/`address`. Тест: S (A3), L — buy_pack и cancel_stale_pack без подписи владельца → `AccountNotSigner`.
4. **Поддельные программы** ✅ — `system/token/associated_token_program` типизированы как `Program<>`; mpl-core, Bubblegum, compression, noop, Switchboard привязаны через `address =`, два проброса в staking::vouchers проверяются в вызываемой chip_core. Тест: S (A4), L — подмена System/Token program → `InvalidProgramId`.
5. **Rent-exempt** ✅ — Anchor `init` + ручной `create_account` только с `Rent::minimum_balance` (compressed.rs, open_compressed_pack). Тест: S (A5/E27).
6. **Повторная инициализация** ✅ — `init` на живой PDA падает; все `init_if_needed` используют либо «принять, если default, затем закрепить владельца», либо PDA, завязанную на payer, + `require_keys_eq!(owner)`. Тест: S (A6), L — повторный `initialize` атакующим (config не изменился), повторный `init_emission` (F1d); L `82-init-authority` — первичный `initialize`/`init_arena` доступен только upgrade authority (фронтран, подмена ProgramData ×4, immutable, без ProgramData); S `init-guard.test.ts` (SEC-F7).

### B. Состояние и CPI
7. **Reentrancy** ✅ — все CPI идут в закреплённые программы (System, Token, mpl-core, Bubblegum, Switchboard, chip_core); обратного вызова в вызывающую программу нет; Solana запрещает реентрантность, кроме self-CPI.
8. **Self-CPI** ✅ — отсутствует. Тест: S (B8).
9. **Устаревший кэш после CPI** ✅ — staking/market передают `ChipState`/claim в chip_core CPI и после него используют только неизменяемые поля (rarity/level); Anchor `exit()` не пишет в чужие аккаунты (owner ≠ program_id), поэтому устаревшая копия не перезапишет данные. В open_compressed_pack метаданные коллекции перечитываются и сохраняются (`exit`) на каждом слоте.
10. **Часы** ✅ — случайность только через commit-reveal Switchboard (слот коммита = slot−1, повторное раскрытие запрещено); `unix_timestamp` используется только для блокировок, TTL и дневных лимитов. Тест: S (B10).

### C. Токены и экономика
11. **Лимит эмиссии** ⚠️→✅ SEC-F1 — mint только в `tick_day` по кумулятивному и годовому лимитам (Σ годовых = 78 % play bucket, тест `schedule_matches_ts_model`), плюс теперь проверка mint'а. Тест: R `cg_mint_guard_enforces_hard_cap_and_no_freeze`, L F1a–F1d.
12. **Token-2022** ✅ — только legacy SPL (`anchor_spl::token`). Тест: S (C12).
13. **Переполнение** ✅ — `overflow-checks = true` в release (unchecked `+`/`-` паникуют, а не заворачиваются); денежная математика — `checked_*`/u128 (split, units_for_cents, pro_rata_refund, rake). Тест: S (C13), существующие Rust-тесты.
14. **Underflow / liabilities** ✅ — `VaultLedger` checked sub; `sweep_vault` оставляет `liab + rent` и читает все шарды (`totals()` проверяет owner, discriminator, shard и канонический bump). Тест: L — оплата на второй token-аккаунт, принадлежащий vault, не даёт вывести обязательства (Σ ≥ liab), G05/G05b.
15. **Округление** ✅ — цены округляются в пользу протокола (`price − conf`, floor на выплатах, ceil на pro-rata возвратах); штраф раннего выхода теперь ceil (SEC-F3). Тест: R `early_exit_penalty_rounds_up_and_never_exceeds_principal`, L S03b (19 / 1 / 201 micro → сгорает 1 / 1 / 11), клиент `unstakePenalty`.
16. **Казна / vault** ✅ — vault = PDA; treasury/buyback закреплены (`has_one`/`address`) во всех выплатах. Тест: L — подмена treasury/buyback/seller в маркете → `InvalidTreasury`/`InvalidBuyback`/`ConstraintAddress`; подмена vault ATA; sweep conservation.
17. **Front-running / MEV** ⚠️→✅ SEC-F5 — buy_pack: `max_lamports` (slippage) + commit-reveal; legacy buy: `expected_price`; compressed buy: теперь `expected_price`. Тест: L SEC-F5 (cancel + relist ×3 в одной tx → `ListingPriceChanged`, покупатель платит только комиссию сети).
18. **DoS циклами** ✅ — все входы ограничены: proof ≤ 24, `remaining_accounts` = 3 / chips×3 / SQUAD / LEDGER_SHARDS, qty ≤ 25. Тест: S (C18).
19. **Экономические эксплойты** ⚠️→✅ SEC-F2 (раздувание редкости). Остальное (pity, odds guard-rail, дневные лимиты, двойной claim Merkle-корня, `WrongRootCurrency`) покрыто существующими тестами. Тест: R Merkle-лист привязан к (wallet, amount, kind, epoch).
20. **God mode админа** ✅/ℹ️ — admin передаётся в 2 шага, pauser может только ставить на паузу, guard-rails на параметры (цена 50–50 000 ¢, fee ≤ 10 %, odds, диапазон цены $CG), события на каждое админ-изменение. ℹ️ `set_params` меняет treasury/feeds без on-chain таймлока (ожидается Squads + таймлок), `stage_compressed_chip` = админская эмиссия claim'ов (теперь с событием, SEC-F4). Тест: S (C20), L — не-админ не может stage.

### D. Специфика Anchor
21. **Space** ✅ — везде `8 + T::INIT_SPACE` ровно для типа поля. Тест: S (D21).
22. **init без payer/seeds** ✅ — Тест: S (D22).
23. **mut** ✅ — writable проверяется Anchor'ом; config read-only во всех игровых путях (#12). Тест: L — read-only vault token → `ConstraintMut`.
24. **Десериализация** ✅ — `Account<T>` (owner + discriminator); ручные `try_deserialize` проверяют discriminator; поля добавляются только в конец структур. Тест: L — аккаунт с чужим owner → `AccountOwnedByWrongProgram`.
25. **Коллизии discriminator'ов** ✅ — одноимённые `#[event]`/`#[account]` в разных программах имеют идентичную раскладку (PauseChanged, PauserChanged…). Тест: S (D25), L — VaultLedger на месте GameConfig → `AccountDiscriminatorMismatch`.
26. **Дрейф IDL/клиента** ⚠️→✅ SEC-F6 — Тест: S — таблицы ошибок = enum'ы Rust (имена и порядок), каждый `ixData('…')` клиента/бэкенда/скриптов существует в `#[program]`.

### E. Рантайм
27. **Compute budget** ✅ — CU-перепись в localnet (`helpers/cu.ts`), лимиты на циклы (п.18).
28. **Close на чужой аккаунт** ✅ — все 16 `close =` платят стороне, привязанной через `has_one`/`address`/`require_keys_eq`. Тест: S (E28), L — чужой пытается отменить stale pack жертвы (seeds/has_one/signer), жертва получает возврат и ренту. SEC-F8 исправлен: донат лампортов на закрытый pending больше не блокирует `close_randomness`.
29. **Дубликаты аккаунтов** ⚠️→✅ SEC-F2 — Anchor 0.31 не проверяет дубликаты (constraint `dup` появится только в 1.0). Все циклы по `remaining_accounts` с записью либо отклоняют повторы, либо привязывают каждый ключ (`pending.materials[m]`, выводимые PDA); арена — `DuplicateChip`, маркет — `SelfTrade`, sweep — `InvalidShard`. Тест: S (E29 + самотест на коде до исправления), R `distinct_material_guard_rejects_every_repeat`, L — `[a,a,a]`, `[a,a,b]`, `[a,b,a]`, `[b,a,a]`, `[r,r,r]` → `DuplicateMaterial`, ничего не сожжено и не списано.
30. **Устаревшие sysvar'ы** ✅ — нет RecentBlockhashes/Fees; SlotHashes закреплён адресом. Тест: S (E30).

## Внешний отчёт A1–A16 (адаптация под наши программы)

Отчёт писался под гипотетическую `programs/game/` (одна программа, раунды `EndRound`, награда из `slot % N`). У нас её нет: 4 программы (chip_core, market, staking, arena), случайность — Switchboard commit-reveal. Идеи, которые ложатся на реальные инструкции, превращены в тесты: L `tests/localnet/83-report-adapted.spec.ts` (R-A1…R-A16), S гейт «A2/A8 `%`» в `anchor-invariants.test.ts`, R `a8_draws_are_unbiased_rejection_samples` в `economy.rs`.

| # | Тема отчёта | Как у нас | Тест |
|---|-------------|-----------|------|
| A1 | переполнение сумм | `overflow-checks = true`, `checked_*`, `split()` в u128 | R `split_sums_to_price` (u64::MAX); **L R-A1**: stake / wager / цена листинга = u64::MAX — чистый отказ, баланс не меняется, листинг отменяется |
| A2 | предсказуемая случайность (`slot`, `unix_timestamp`) | только Switchboard commit-reveal в PDA `["rng", kind, owner, nonce]` | S B10 (часы запрещены в randomness/economy); **S A2/A8** (`%` только в ревьюнутых функциях) |
| A3 | повторный `EndRound` / двойная выплата | раундов нет; аналоги — `open_pack` (pack_no), `resolve_battle` (status), `claim_*` (receipt PDA) | L C14, A03–A05, S-серия claim |
| A4 | чужой токен-аккаунт как источник | `token::authority = buyer/owner/challenger` в BuyPack / StakeCg / CreateBattle | **L R-A4**: подмена ATA жертвы → ошибка Anchor-констрейнта (20xx), жертва не тронута; S C2/C16 |
| A6 | нулевые и граничные суммы | `BelowMinimum`, `WagerRange`, `PriceTooLow`, qty 0 | **L R-A6**: stake 0, wager 0 / MIN−1 / MAX+1 отклонены, MIN и MAX проходят; C04, S21 |
| A7 | порядок проверок в `EndRound` | N/A; код отчёта противоречит сам себе (проверка после перевода) — у нас все проверки в констрейнтах до CPI | — |
| A8 | смещение `slot % N` | rejection sampling по u32-окну (`uniform_bps`, `uniform_pool`) | **R** точная проверка порога + χ-подобная проверка 300 000 выборок (±3 %), контрольный `byte % 10` ловится; **S** гейт `%` |
| A9 | реентрантность через токен-колбэк | невозможна: legacy SPL Token без хуков (S C12), self-CPI запрещён (S B8) | S B8, C12 |
| A12 | пауза запирает средства | пауза гейтит только входы | **L R-A12**: при паузе chip_core + staking + arena работают unstake CG, unstake чипа, delist, возврат stale-пака, отмена боя; buy / stake / create → `Paused` |
| A13 | аккаунты ниже rent-exempt | рантайм не даёт создать или оставить такой аккаунт | **L R-A13**: sweep синглтонов и аккаунтов из флоу; нашли **SEC-F10** |
| A16 | «потеря ренты при неудачной tx» | неудачная tx откатывается целиком | **L R-A16**: `init_randomness + buy_pack` со Slippage → нет ни randomness, ни PendingPack, ledger не изменился, потеря ≤ комиссии, тот же nonce снова доступен (и то же для боя в R-A1) |

Остальные пункты (A5, A10, A11, A14, A15) не дали новых сценариев: они совпадают с пунктами основного чек-листа выше (подписи и владельцы — A1–A6, админ-роли и пауза — C17/C20, лимиты входов и CU — C18/E27) и уже закрыты существующими гейтами и спеками.

Неверные утверждения отчёта: A8 «слоты всегда чётные» — нет; A9 «реентрантность через колбэк токена» — в SPL Token без transfer-hook её нет, в Solana возможен только self-CPI (запрещён гейтом B8); A13 «аккаунт может уйти ниже ренты и быть удалён» — рантайм отклоняет такую tx; A16 «рента теряется при откате» — откатывается всё, кроме комиссии; A3/A7 — пример `EndRound` делает перевод до проверки и одновременно утверждает обратное.

## Бэкенд: дополнительный проход

- **Авторизация** (`auth.ts`): SIWS с одноразовым nonce (атомарное удаление после проверки подписи), домен из конфига, дрейф `Issued At`, HttpOnly-cookie с HMAC + CSRF double-submit, лимиты nonce на кошелёк — замечаний нет.
- **Reward oracle** (`reward-oracle.ts`): исходные строки помечаются `(root_kind, root_epoch)` в той же DB-транзакции, что и сборка батча; один pending-батч на kind; повтор публикации упирается в on-chain `init` эпохи — двойная выплата невозможна.
- **Рейтинговая арена** (`arena.ts`): commit-reveal с секретом сезона — второй раскрывающий не может предсказать исход; nonce соперника скрыт до конца матча. Найдена **SEC-F11** (фарм рейтинга на ботах) — исправлена.
- Замечание (Info, без фикса): состав отряда проверяется при входе в очередь; после передачи чипов тот же отряд может одновременно стоять в очереди у другого кошелька. Выгода ограничена дневным лимитом наград на кошелёк, device-лимитом (`human.ts`) и детектором wash-trade (`antifraud.ts`).

## Тесты, добавленные этим аудитом

- `backend/test/game.test.ts` «SEC-F11 bot farming» — 300 бот-матчей моно-стихийным отрядом не поднимают рейтинг выше старт + 350.
- `tests/localnet/83-report-adapted.spec.ts` — 6 сценариев по внешнему отчёту A1–A16 (R-A1, R-A4, R-A6, R-A12, R-A13, R-A16), см. раздел выше; Rust `a8_draws_are_unbiased_rejection_samples`.
- `tests/localnet/82-init-authority.spec.ts` — 6 сценариев SEC-F7 на отдельной LiteSVM: без ProgramData / immutable → никто; фронтран атакующего → `NotUpgradeAuthority`; поддельная ProgramData (чужой адрес, не тот владелец, ProgramData другой программы, ProgramData arena → chip_core) → отказ; старый 4-аккаунтный `initialize` → отказ; upgrade authority инициализирует обе программы.
- `tests/localnet/80-security.spec.ts` SEC-F8 — донат ренты на закрытый pending PDA, затем `close_randomness` возвращает ренту владельцу.
- `tests/security/init-guard.test.ts` — 11 тестов SEC-F7 (включая разбор заголовка ProgramData и pre-flight upgrade authority в setup); ранее 8: захваченный config / arena / emission отклоняется, `pending_admin = мы` не «отмывает» чужой config, свой config и мультисиг после передачи (`SETUP_EXPECTED_ADMINS`) проходят, дрейф treasury/buyback — предупреждение, base58 сверен с `@solana/web3.js`, `setup.ts` не содержит голых `exists(…) → skip` для синглтонов.
- `tests/security/anchor-invariants.test.ts` (+ `lib/rust-scan.ts`) — 23 статических гейта (в т.ч. A2/A8 `%`, добавлен по отчёту A1–A16): `npm run security:static`, шаг CI в job `economy`. У каждого правила 0 срабатываний на HEAD; каждое исключение перечислено в allowlist с причиной. Самотесты проверяют, что правила срабатывают на синтетических уязвимых фрагментах (включая цикл слияния до исправления). Мутационная проверка: откат SEC-F2 / SEC-F4 / SEC-F6 или удаление `has_one = bidder` роняет соответствующий гейт.
- `tests/localnet/80-security.spec.ts` — 11 атакующих сценариев на LiteSVM с реальными программами (в каждом ровно одна мутация + успешная контрольная транзакция).
- `tests/localnet/81-emission-mint-guard.spec.ts` — 4 сценария SEC-F1 на отдельной цепочке.
- Rust: `distinct_material_guard_rejects_every_repeat`, `only_the_recorded_upgrade_authority_passes` (chip_core), `cg_mint_guard_enforces_hard_cap_and_no_freeze`, `merkle_leaf_binds_wallet_amount_kind_epoch` (staking). `early_exit_penalty_rounds_up_and_never_exceeds_principal` (staking, SEC-F3).
- `tests/localnet/50-staking.spec.ts` S03b — SEC-F3 на LiteSVM: досрочный вывод 19 / 1 / 201 micro-$CG сжигает ровно 1 / 1 / 11, принципал уменьшается на выведенное.

## Несовместимые изменения интерфейса

- `market::buy_compressed(expected_price: u64)` и `buy_compressed_asset(delegate, proof, expected_price: u64)` — новый обязательный аргумент. Клиентские билдеры `buyCompressedSolIx` / `buyCompressedAssetIx` требуют `expectedPrice` (цену, которую увидел пользователь).
- Новые коды ошибок, добавлены в конец enum'ов (существующие коды не сдвинулись): `StakeError::BadMint` (6032), `MarketError::ListingPriceChanged` (6014).
- Поведение `unstake_cg` (SEC-F3): штраф раннего выхода округляется вверх — для «круглых» сумм без изменений, на остатках отличие ≤ 1 micro-$CG. Превью в клиенте и бэкенде обновлены синхронно.
- `chip_core::initialize` и `arena::init_arena` (SEC-F7): новый последний аккаунт `program_data` (ProgramData программы); вызывать может только upgrade authority. Новые коды: `ChipError::NotUpgradeAuthority = 6045`, `ArenaError::NotUpgradeAuthority = 6016` (в конце enum'ов). Порядок деплоя: deploy (upgradeable) → `npm run setup` тем же ключом → передача upgrade authority на Squads (docs/09). `run-validator` грузит программы через `--upgradeable-program … <admin>`.
- `npm run setup` (SEC-F7): прерывается, если существующий config / arena config / emission принадлежит чужому admin. После передачи admin мультисигу перезапуск требует `SETUP_EXPECTED_ADMINS=<pubkey мультисига>`.

---

**Проверка в CI:** все jobs зелёные, включая `rust · clippy + unit tests`, `programs · fmt + anchor build`, `security:static` и `localnet · LiteSVM` (120 кейсов, в том числе спеки 80–83); последний прогон — run 36204240809 (@875d8be).
