# Промпт для следующей сессии

Снимок: `main` на 2026-09-18, то есть после `323a9c3` (канал чтения localnet-отчёта) и после `5841344`
(первый зелёный `programs`). Ниже — текст, который вставляется в новый чат целиком. Он
самодостаточен: новые сессии не наследуют ни память, ни недочитанные прогоны, а половина цены этой работы —
как раз в том, чтобы не повторять уже проверенное.

---

```
Работай в /home/user/caps (репозиторий Leo88q/caps). Задача — довести проект до деплоя по списку гейтов
docs/09-production-readiness.md (§0 вердикт, таблица гейтов G-0…G-7, дальше по §). Все изменения — коммитить и
пушить в рабочую ветку; репозиторий уже содержит всё сделанное ранее в main, новых веток не плодить.

КАК РАБОТАТЬ В ЭТОЙ СРЕДЕ (правила, каждая строка оплачена прогоном):
1. Компилятора локально нет: rust/cargo/docker отсутствуют, сети для bash почти нет (npm-registry доступен —
   `npm ci` и все node-гейты работают, `npm run verify` обязан быть зелёным перед любым пушем). Rust-код
   проверяется ТОЛЬКО прогоном CI: правка → push → прочитать вердикт → чинить по аннотациям.
2. Логи Actions недоступны (gh api …/logs отдаёт пустой ответ; gh run view --log тоже). Единственный канал —
   аннотации: `gh api repos/Leo88q/caps/check-runs/<job_id>/annotations --jq '.[] | "[\(.annotation_level)] \(.path):\(.start_line) :: \(.message)"'`,
   где job_id из `gh api repos/Leo88q/caps/actions/runs/<run_id>/jobs`. Длинные куски логов приходят в поле
   message как base64 с префиксом `log64:` — декодировать. Для localnet-отчёта есть отдельный канал:
   scripts/ci-surface-junit.sh публикует каждый <failure> аннотацией (cap 12 + строка учёта).
3. gh workflow run недоступен (403 от интеграционного токена). Единственный триггер — пуш. Cargo.lock НЕ
   правится руками: чтобы пересобрать лок (например класс edition2024 вернулся), удалить Cargo.lock коммитом —
   .github/workflows/lockfile.yml резолвит, применяет SBFPINS из scripts/ci-cargo-lock.sh, доказывает
   `cargo check --workspace --all-targets` + scripts/ci-sbf-toolchain-check.sh и сам коммитит результат; без
   зелёного чека лок не коммитится.
4. НЕ ТРОГАТЬ: solana_version/tools-version в Anchor.toml (класс «манифест не читается старым cargo» решается
   пинами в SBFPINS, не сменой тулчейна); features = ["anchor"] у mpl-core и switchboard-on-demand в
   programs/*/Cargo.toml (это валидно, default-features = false сохранять; допустимы только аддитивные правки,
   вроде диапазона `>=0.11.1, <0.12`).
5. Секреты не коммитить никогда. Перед `git add -A` всегда `git status --short` (в этой истории уже уехал в
   коммит поддельный Cargo.lock, оставленный фикстурой, писавшей в корень репозитория).
6. Пустой вывод — не успех. Отличай «проверка прошла» от «проверка не запустилась / ref не существует /
   вывод подавлен 2>/dev/null». Первый вопрос к красному шагу: «выполнилась ли его команда вообще» (код выхода
   9 у node = отвергнутый флаг, а не вердикт скрипта; лог в 125 байт = ничего не запускалось).
7. Токен GitHub в песочнице периодически отвечает 401 Bad credentials. Это не поломка репозитория: проверять
   `gh api rate_limit`, повторять, и НИКОГДА не делать выводов из молчания API (ни «зелёно», ни «красно»).

ЧТО УЖЕ ДОКАЗАНО (не переделывать, но и не считать надёжнее, чем доказано):
- Cargo.lock в ветке, производен машиной: 350 пакетов, одна копия anchor-lang (0.31.1), одна borsh 1.x,
  solana-program только 2.3.0, wasip2/wit-bindgen/toml_parser отсутствуют. Форма проверена по файлу.
- ci.yml run 76: впервые `anchor build` завершился нулём. Run 79: впервые зелёным стал ВЕСЬ job programs
  (fmt, `--locked`, SBF-toolchain-check, anchor build --features localnet, сверка id, upload-artifact с
  .so/IDL/types). §1.1 docs/09 закрыт (обход PriceUpdateV2 через /// CHECK: + ручной AccountDeserialize).
- `rust`-джоба (clippy -D warnings --locked + cargo test --workspace) зелёная; E0277 был артефактом отсутствия
  лока, а не кода.
- Механизм пинов и его тесты: scripts/ci-cargo-lock.sh (обход графа до неподвижной точки, dev-рёбра,
  некритичные отказы, аудит лока, notice про мёртвые строки) + scripts/selftest-cargo-lock.sh (31 проверка /
  7 сценариев, в verify как selftest:cargolock).
-Legibility-обвязка CI: scripts/ci-run-logged.sh, ci-surface-log.sh, ci-surface-junit.sh
  (+ selftest-surface-junit.sh, 21 проверка / 4 сценария), scripts/check-workflows.ts (npm run workflows:check).
- Смысл шага «program ids agree…»: он в джобе economy (в контейнере якоря он не мог запуститься), строгий
  `program-ids -- check` — только на церемонии (ops/deploy/runbook.md §1.1).

НЕ СДЕЛАНО — в этом порядке:
1. localnet (G-2): 83 сценария на litesvm исполняются впервые и КРАСНЫЕ. Обвязка исправна: артефакты скачаны,
   mpl_core.so получен с mainnet, падает сам `npm test`. Прочитай аннотации свежего прогона (начиная с
   `323a9c3` они пофайловые) и чини сценарии/программы, а не гейт. Первые кандидаты: (а) id, под которыми программы
   загружаются в сьют, не совпадают с declare_id! (target/deploy/*-keypair.json при сборке фабрикуется якорем —
   смотри tests/localnet/helpers/env.ts и run-validator.ts, как именно выбирается адрес загрузки); (б) расхождение
   layout/дискриминаторов между IDL и TS-билдерами (client/src/chain/ix/*.ts зеркалит #[derive(Accounts)] 1:1);
   (в) ожидания localnet-фичи (sb_mock, SB_PROGRAM_ID). Не ослабляй guard «the suite really ran» и не переводи
   падающие спеки в skip — ложная зелень обошлась бы дороже, чем красный.
2. docs/09 §3.3 до конца: решить судьбу continue-on-error у трёх ночных джоб (lighthouse, e2e-devnet, load-smoke) —
   снять или записать в docs, почему они остаются диагностикой, а не гейтом (внешние сервисы, schedule-only).
3. §2, программа-айдизи: церемония id. `npm run program-ids -- new --out DIR` → `apply --from DIR` (переписывает
   13 мест) → `manifest` → коммит programs/program-ids.json вместе с тегом audit-v1-<date>. id сейчас —
   dev-плейсхолдеры, общие для devnet и mainnet (см. комментарий в Anchor.toml), и без этого шага verifiable
   build и аудит не имеют предмета. После apply: `npm run economy:check`, `npm run program-ids -- check`,
   прогон CI, и перепроверить, что localnet не сломался на смене id.
4. G-3 devnet-соак: деплой четырёх программ (devnet-ключ, не mainnet!), 14 дней, ≥10 000 паков, crank
   довернуть до конца: SEC-C3 часть 3 (backend-криллер reveal) — проверить по docs/06 и ops/deploy/runbook.md.
5. G-1 аудит: docs/08 (P0: SEC-C1/C2/C3/H1/H2 + T-L-*), скоуп в docs/06 занижен в 2.4× построчно — сверить и
   выровнять; до аудита нужен зелёный localnet (см. 1) и замороженные id (см. 3).
6. Продуктовый «last mile» из docs/09 §0: ToS/Privacy (0 файлов), art/иконки для dApp Store, критический путь клиента
   на 48% тяжелее собственного бюджета, Postgres-слой (prisma/schema.prisma описан, в коде node:sqlite),
   инфраструктурные манифесты (Dockerfile/compose/deploy-workflow/nginx — частично закрыто images.yml,
   сверить фактическое наличие), docker-деploy.
7. Если вернётся класс «манифест не читается cargo 1.79» (обычно после обновления зависимостей): красный шаг
   `the SBF toolchain can read this lock` + `::notice` с готовой строкой SBFPINS — добавить строку/пины, пушнуть,
   дождаться lockfile.yml. Не понижать тулчейн и не править лок руками.

ПОСЛЕ ЛЮБОЙ ПРАВКИ: `npm run verify` локально (включая economy:check, program-ids -- status, workflows:check,
оба selftest, docs:refs), пуш, затем ПРОЧИТАТЬ прогон этой ветки и записать факт в docs/09 (§0 вердикт,
строку гейта, §1.4 для истории прогонов). Формулировки в docs обязаны отличаться от «ожидаю» — пиши, что
показал прогон, а не что должен был показать; если не прочитал — так и напиши.
```
