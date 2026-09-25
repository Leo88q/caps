# Аудит безопасности по чек-листу Solana/Anchor — 2026-09-25

Область: `programs/chip_core`, `market`, `staking`, `arena` (Anchor 0.31.1, solana 2.1, rust 1.89,
`overflow-checks = true`). `programs/sb_mock` — только localnet-мок Switchboard, вне области.
Предыдущие отчёты (SECURITY-ECON-AUDIT-2026-09-21, SECURITY-SCAN-TRIAGE-2026-09-23) учтены; здесь —
только то, что проверено заново, плюс новые находки.

## Находки

| ID | Серьёзность | Пункт | Где | Суть | Статус |
|----|-------------|-------|-----|------|--------|
| SEC-F2 | **High** | 29, 19 | `chip_core/src/instructions/compressed.rs` `fuse_compressed_claims` | Нет проверки дубликатов в `remaining_accounts`: один и тот же claim, переданный 3 раза, проходил все проверки, помечался `consumed` один раз, а результат следующей редкости всё равно создавался. Рецепты 0–3 — 100 % успех без блокировки результата, поэтому один settlement-free claim (любой результат слияния или admin-staged) превращался в claim на 1–4 ступени выше (вместо 3/9/27/81 материалов). Это раздувает редкость, вес стейкинга и цену на маркете. В рандомизированном пути (`fuse_claims_commit`) и в пути через Core (`fuse` → `load_materials`) такая проверка была. | **Исправлено**: общий хелпер `ensure_distinct_material` (compressed.rs:299) вызывается в обоих путях (:709, :936) |
| SEC-F5 | **Medium** | 17 | `market/src/lib.rs` `buy_compressed`, `buy_compressed_asset` | У покупателя нет защиты по цене: продавец мог атомарно сделать `cancel_compressed` + `list_compressed` по более высокой цене раньше транзакции покупателя (или в бандле), и покупатель платил цену на момент исполнения. В legacy-`buy` защита `expected_price` уже была. | **Исправлено**: аргумент `expected_price: u64` + `MarketError::ListingPriceChanged` (lib.rs:1102, :1447); клиентские билдеры требуют `expectedPrice` |
| SEC-F1 | **Medium** | 11, 20 | `staking/src/instructions/emission.rs` `init_emission` | docs/02 обещает hard cap 1 млрд и отсутствие freeze authority, но проверялись только `decimals == 6`. К синглтону эмиссии навсегда могли привязать mint с freeze authority (её держатель может заморозить $CG любого игрока или пула) или с предварительной эмиссией сверх не-игровой доли (supply + 550 M игровой эмиссии > 1 B). | **Исправлено**: `validate_cg_mint` (emission.rs:57): `freeze_authority == None`, `supply ≤ HARD_CAP − PLAY_BUCKET` (450 M); `StakeError::BadMint` |
| SEC-F4 | Low | 20 | `compressed.rs` `stage_compressed_chip` | Единственный админ-путь, создающий claim **любой** редкости «из воздуха», не эмитил событий: действия скомпрометированного или ошибившегося админа не оставляли следа в индексере. | **Исправлено**: событие `CompressedChipStaged` (state.rs, compressed.rs:283) |
| SEC-F6 | Low | 26 | `client/src/chain/errors.ts`, `tests/localnet/helpers/expect.ts` | В таблицах ошибок market не было `InvalidTreasury`/`InvalidBuyback`: коды 6012/6013 показывались пользователю как «неизвестная ошибка». Кроме того, в `BuyCompressed`/`BuyCompressedAsset` подмена treasury/buyback отклонялась общим `ConstraintAddress` (2012) — теперь `address = … @ InvalidTreasury/InvalidBuyback`, как в legacy `Buy` (защита не менялась, только тип ошибки). | **Исправлено** + статический гейт D26 |
| SEC-F3 | Info | 15 | `staking/src/state.rs::early_exit_penalty`, `stake.rs:164` | Штраф за досрочный unstake `amount * bps / 10_000` округлялся вниз: при выводе частями ≤ 19 micro-$CG (500 bps) штраф был 0. Экономически бессмысленно (комиссия tx ≫ выгода), но это обход правила. | **Исправлено**: `⌈amount·bps/10 000⌉` в программе, клиенте (`unstakePenalty`) и бэкенде; R `early_exit_penalty_rounds_up_and_never_exceeds_principal`, L S03b |
| SEC-F7 | Info | 17, 6 | `chip_core::initialize`, `arena::init_arena` | Нет проверки upgrade authority: между деплоем и `initialize` кто угодно может инициализировать config со своим admin/treasury (first caller wins). Хуже того, `npm run setup` при существующем config писал «exists — skip» и молча принимал чужой config (и его mint'ы). `init_emission` защищён: mint authority должна подписать `set_authority` (тест F1c). | **Частично исправлено** (офчейн): `scripts/init-guard.ts` — setup прерывается, если admin существующего config / arena config / emission не деплойер и не из `SETUP_EXPECTED_ADMINS` (pending_admin намеренно не засчитывается); тест S `tests/security/init-guard.test.ts`. On-chain проверка upgrade authority — рекомендация (меняет список аккаунтов `initialize` и LiteSVM-харнесс); деплой + setup — одним окном, затем `npm run verify-deploy` |
| SEC-F8 | Info | 28 | `chip_core/src/instructions/rng.rs:272` | `close_randomness` требует `pending.lamports() == 0`: если кто-то переведёт ≥ rent-minimum на адрес закрытого pending PDA, рента randomness-аккаунта (~0.002 SOL) этого nonce заблокируется. Атакующему это стоит примерно столько же, сколько теряет жертва; средства пользователя не затронуты. | Принято |
| SEC-F9 | Info | 20 | arena `resolve_battle` | Победителя выбирает оракул (roll только эмитится). Ограничено `oracle_daily_cap`, победитель обязан быть участником, `winner_cg.owner == winner`. Централизованное доверие — известный принятый риск (SECURITY.md). | Принято |

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
6. **Повторная инициализация** ✅ — `init` на живой PDA падает; все `init_if_needed` используют либо «принять, если default, затем закрепить владельца», либо PDA, завязанную на payer, + `require_keys_eq!(owner)`. Тест: S (A6), L — повторный `initialize` атакующим (config не изменился), повторный `init_emission` (F1d); S `init-guard.test.ts` — setup отказывается принять config, инициализированный чужим ключом (SEC-F7).

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
28. **Close на чужой аккаунт** ✅ — все 16 `close =` платят стороне, привязанной через `has_one`/`address`/`require_keys_eq`. Тест: S (E28), L — чужой пытается отменить stale pack жертвы (seeds/has_one/signer), жертва получает возврат и ренту. ℹ️ SEC-F8.
29. **Дубликаты аккаунтов** ⚠️→✅ SEC-F2 — Anchor 0.31 не проверяет дубликаты (constraint `dup` появится только в 1.0). Все циклы по `remaining_accounts` с записью либо отклоняют повторы, либо привязывают каждый ключ (`pending.materials[m]`, выводимые PDA); арена — `DuplicateChip`, маркет — `SelfTrade`, sweep — `InvalidShard`. Тест: S (E29 + самотест на коде до исправления), R `distinct_material_guard_rejects_every_repeat`, L — `[a,a,a]`, `[a,a,b]`, `[a,b,a]`, `[b,a,a]`, `[r,r,r]` → `DuplicateMaterial`, ничего не сожжено и не списано.
30. **Устаревшие sysvar'ы** ✅ — нет RecentBlockhashes/Fees; SlotHashes закреплён адресом. Тест: S (E30).

## Тесты, добавленные этим аудитом

- `tests/security/init-guard.test.ts` — 8 тестов SEC-F7: захваченный config / arena / emission отклоняется, `pending_admin = мы` не «отмывает» чужой config, свой config и мультисиг после передачи (`SETUP_EXPECTED_ADMINS`) проходят, дрейф treasury/buyback — предупреждение, base58 сверен с `@solana/web3.js`, `setup.ts` не содержит голых `exists(…) → skip` для синглтонов.
- `tests/security/anchor-invariants.test.ts` (+ `lib/rust-scan.ts`) — 21 статический гейт: `npm run security:static`, шаг CI в job `economy`. У каждого правила 0 срабатываний на HEAD; каждое исключение перечислено в allowlist с причиной. Самотесты проверяют, что правила срабатывают на синтетических уязвимых фрагментах (включая цикл слияния до исправления). Мутационная проверка: откат SEC-F2 / SEC-F4 / SEC-F6 или удаление `has_one = bidder` роняет соответствующий гейт.
- `tests/localnet/80-security.spec.ts` — 11 атакующих сценариев на LiteSVM с реальными программами (в каждом ровно одна мутация + успешная контрольная транзакция).
- `tests/localnet/81-emission-mint-guard.spec.ts` — 4 сценария SEC-F1 на отдельной цепочке.
- Rust: `distinct_material_guard_rejects_every_repeat` (chip_core), `cg_mint_guard_enforces_hard_cap_and_no_freeze`, `merkle_leaf_binds_wallet_amount_kind_epoch` (staking). `early_exit_penalty_rounds_up_and_never_exceeds_principal` (staking, SEC-F3).
- `tests/localnet/50-staking.spec.ts` S03b — SEC-F3 на LiteSVM: досрочный вывод 19 / 1 / 201 micro-$CG сжигает ровно 1 / 1 / 11, принципал уменьшается на выведенное.

## Несовместимые изменения интерфейса

- `market::buy_compressed(expected_price: u64)` и `buy_compressed_asset(delegate, proof, expected_price: u64)` — новый обязательный аргумент. Клиентские билдеры `buyCompressedSolIx` / `buyCompressedAssetIx` требуют `expectedPrice` (цену, которую увидел пользователь).
- Новые коды ошибок, добавлены в конец enum'ов (существующие коды не сдвинулись): `StakeError::BadMint` (6032), `MarketError::ListingPriceChanged` (6014).
- Поведение `unstake_cg` (SEC-F3): штраф раннего выхода округляется вверх — для «круглых» сумм без изменений, на остатках отличие ≤ 1 micro-$CG. Превью в клиенте и бэкенде обновлены синхронно.
- `npm run setup` (SEC-F7): прерывается, если существующий config / arena config / emission принадлежит чужому admin. После передачи admin мультисигу перезапуск требует `SETUP_EXPECTED_ADMINS=<pubkey мультисига>`.

---

**Проверка в CI:** все jobs зелёные, включая `rust · clippy + unit tests`, `programs · fmt + anchor build` и `localnet · LiteSVM` (106 кейсов, в том числе новые спеки 80/81; прогон с SEC-F3/SEC-F7 — см. последний коммит ветки).
