# 10 · Runbook: сборка, деплой, мониторинг, откат

> Документ для того, кто нажимает Enter на проде. Всё, что здесь написано, существует в репозитории:
> команды — из корневых `package.json`-скриптов, метрики — из `backend/src/metrics.ts`, пути — из
> `ops/deploy/`. Если runbook и код расходятся, неправ runbook (это единственный способ заметить,
> что инструкция устарела).
>
> Читается сверху вниз для первого деплоя (§0→§2), и по разделам — во время инцидента (§6).
> Лицензионно-юридическое и всё, что требует рук владельца (мультиподпись, Hermes-ключ, домены),
> — в `docs/09-production-readiness.md §7`, здесь только ссылки.

## 0. Предусловия

Один хост, Docker ≥ 27 (`docker compose version`), 2 vCPU / 4 GB / 40 GB SSD на старте, открытый
443 (или отсутствие открытого 443, если TLS терминирует платформа). Проверить перед первым запуском:

```bash
docker compose version          # нужен ≥ v2.24: env_file с required:false
node -v                          # ≥ 22.13 — бэкенд работает на node:sqlite
npm ci && npm run verify         # все оффлайн-проверки должны быть зелёными ДО сборки
```

`verify` включает `economy:check` (константы on-chain ⇄ TS), `api:check` (openapi ⇄ маршруты),
`program-ids -- status` (все копии id согласованы) и `env:check` (каждая переменная окружения
описана). Красный `verify` перед деплоем — это не «потом поправлю», а «я деплою неизвестно что».

## 1. Первый деплой

### 1.1 program id (только если ещё не заморожены)

Если `npm run program-ids -- status` говорит `unverified`, а `target/deploy/*-keypair.json` нет —
это коммит с плейсхолдерами, и в mainnet так деплоить нельзя. Процедура целиком в
`docs/09-production-readiness.md §2`: `program-ids -- new` → церемония мультиподписи →
`program-ids -- apply` → `manifest`. После заморозки id не «правятся руками»: только `apply`.

### 1.2 конфиг

```bash
cd ops/deploy
cp .env.example .env              # что обязательно — написано в шапке файла
cp ../../backend/.env.example ../../backend/.env
```

В `backend/.env` обязательно: `SESSION_SECRET` (≥ 32), `SIWS_DOMAINS`, `ADMIN_WALLETS`,
`TURNSTILE_SECRET` (или явный `HUMAN_CHECK=0`), `SOLANA_RPC_URL` (для индексора — с рабочим
websocket-эндпоинтом), четыре `PROGRAM_*`, минты. Остальное имеет дефолты в коде; `env:check`
не даст списку разойтись.

Юридический гейт (продажа паков в BE/NL) по умолчанию выключен и включается **только** вместе с
доверием к заголовку с страны: `GEO_GATE=shop` + `GEO_TRUST_HEADER=1` в `ops/deploy/.env`, при
Cloudflare перед nginx (иначе `assertProductionConfig` откажется стартовать — см. `backend/src/geo.ts`).
`GEO_UNKNOWN=block` — строгое чтение «мы не имеем права продавать, пока не уверены в регионе»: неизвестная
страна = отказ в покупке; при `allow` (дефолт) сломанный edge тихо превращается в «гейта нет», и это
осознанный выбор между двумя видами аварии.

Проверить, что прод-конфиг не противоречив, можно не поднимая контейнер:

```bash
cd backend && npx tsx -e "process.env.NODE_ENV='production'; await import('./src/config.ts')"
```

`assertProductionConfig()` бросит список проблем — это и есть gate перед стартом: он ловит
wildcard-CORS, `COOKIE_SECURE` без https, `:memory:` в проде, `EVENT_BUS=redis` без `REDIS_URL`,
`API_INGEST=0` без Redis (в этом случае `/ws` не заработает никогда), `FINALITY_ASSUME=1`.

### 1.3 TLS — чей это слой

`ops/deploy/nginx.conf` внутри контейнера слушает 8080 и не терминирует TLS: сертификат должен жить
там, где живёт DNS. Два рабочих варианта:

* TLS терминирует платформа (Cloudflare / Fly / ALB) — тогда `HTTP_BIND=127.0.0.1`, а наружу
  смотрит их балансировщик; в `nginx.conf` включается комментарий про
  `X-Forwarded-Proto`, и ничего больше менять не надо.
* TLS на этом же хосте — тогда сертификат от ACME (certbot/caddy) монтируется в контейнер, и
  раскомментируется блок `listen 443 ssl` в конце `nginx.conf`.

`COOKIE_SECURE`/`SameSite=None` и SIWS-домен впривязаны к https: `assertProductionConfig`
откажется стартовать без них, поэтому «забыл TLS» превращается в отказ запуска, а не в сессию,
которая живёт час и падает на мейне.

### 1.4 секреты контейнера

Key_pair'ы не положены в `environment:` — они видны в `docker inspect` и в `compose ps`.
Compose-mounted `secrets:` (файловый драйвер) кладёт их в `/run/secrets/…`:

```bash
mkdir -p ops/deploy/secrets
install -m 0600 /путь/к/crank-keypair.json ops/deploy/secrets/crank_keypair.json
```

`ops/deploy/secrets/.gitignore` (`*` + `!.gitignore`) не даст этому файлу уехать в git, а
корневой `*-keypair.json`-правило ловит остальные случаи.

### 1.5 сборка и старт

```bash
npm run env:check       # офлайн: каждая ${VAR} из compose описана в .env.example и наоборот
npm run ops:config      # валидация самого compose (этот шаг уже требует Docker)
npm run ops:build       # два образа: client (Vite→nginx) и api (node:22.13.0-slim)
npm run ops:up
npm run ops:ps          # api: healthy. client: healthy. redis: healthy
curl -fsS localhost:8080/healthz && curl -s localhost:8080/readyz | head -c 400
```

`/readyz` будет 503 первые минуты — идёт первичный backfill (это правильно для балансировщика;
`BACKFILL_START_PERIOD` в compose — это `start_period` healthcheck'а, чтобы контейнер не
перезапускали за то, что он догоняет).

## 2. Инициализация данных (только при первом запуске на кластере)

Порядок не произвольный: `setup` создавает on-chain-аккаунты, `create-lut` — lookup-таблицу, без
неё `reveal + open_pack` не влезает в одну транзакцию и crank для паков на 5 чипов падает
(docs/06 §4.2 вывод 3).

```bash
npm run setup            # config PDA, коллекции, $CG-минт … — требует deployer-ключа
npm run create-lut       # адрес → в backend/.env (LOOKUP_TABLE) и в client (VITE_LOOKUP_TABLE)
npm run backend:backfill  # уже запущен внутри api (API_INGEST=1); нужен только для переиндексации
npm run backend:crank      # то же: отдельный запуск нужен только для разбора зависших задач
```

После этого — смоук: купить стартовый пак на devnet, дождаться `pack_opened` в `npm run ops:logs`,
убедиться что `/v1/wallet/<addr>/events` отдаёт событие, а `/ws` его доставил (в браузере:
`new WebSocket('/ws?wallet=…')`, затем покупка → должен прийти кадр).

## 3. Мониторинг

### 3.1 что смотреть

Единственный источник — `/metrics` api-контейнера (скрейпится `api:8787`, nginx наружу его не
отдаёт кроме внутренних CIDR). Ключевые серии и почему именно они:

| серия | вопрос, на который она отвечает |
|---|---|
| `ready`, `ingest_lag_slots`, `ingest_last_slot` | видит ли игрок свои события |
| `crank_pending_jobs`, `crank_abandoned_jobs`, `crank_balance_sol`, `crank_balance_readable` | открываются ли паки и есть ли чем |
| `pyth_cache_age_seconds` | можно ли честно оценить пак (StalePrice = отказы покупки) |
| `http_requests_total{route,status}` , `http_request_duration_ms` | деградация API, а не «в целом плохо» |
| `ws_clients`, `ws_events_total`, `ws_dropped_total` | жив ли real-time; `ws_dropped_total` растёт = клиент не читает |
| `metrics_series`, `process_open_handles`, `nodejs_heap_used_bytes` | метрика как источник аварии |
| `process_crashes_total` | всё, что упало и было поднятo супервизором |

### 3.2 алерты

`ops/monitoring/alerts.yml` — правила; `npm run ops:prometheus` поднимает Prometheus с ними.
Профиль `monitoring` включён не во всех деплоях, поэтому проверять так:

```bash
curl -s localhost:9090/api/v1/rules | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(len(g["rules"]) for g in d["data"]["groups"]), "rules")'
```

Alertmanager пока не подключён (`alerting.alertmanagers: []` — это осознанное состояние, а не
забытая строчка): правила грузятся, `annotations` читаются как мини-runbook, а доставка — в
`docs/09 §7` у владельца (PagerDuty/Telegram-бот). Тест `backend/test/monitoring.test.ts` не даст
правилу сослаться на серию, которой нет: мёртвый алерт хуже отсутствия алерта, потому что он
успокаивает.

## 4. Бэкапы


> Почему база именно такая и по какому признаку её менять: `ops/deploy/data-layer.md` (измеренный инвентарь SQLite-диалекта, RPO варианта A, цена Postgres-порта).

### 4.1 как это работает

SQLite, не Postgres, поэтому `litestream` здесь не при чём. Сервис `backup` каждый час делает
`sqlite3 .backup` (консистентный снимок читающего соединения, а не `cp` файликов WAL), затем
`PRAGMA integrity_check` на копии, затем `gzip`, затем — если задан `BACKUP_S3_URI` — `aws s3 cp`.
Хранение на хосте — `BACKUP_KEEP` снимков (72 × час = 3 дня).

```bash
npm run ops:backup-now                                   # снимок вручную, прямо сейчас
docker compose -f ops/deploy/docker-compose.yaml logs backup --since 1h | tail
```

`integrity_check FAILED` = `ALERT` в логах и файл с суффиксом `.CORRUPT`; loop продолжается,
следующий час попробует снова.

### 4.2 восстановление (дрилл обязателен)

Снятие бэкапа без проверки на восстановление — это вера, а не план. Дрилл раз в квартал, на том же
хосте, в отдельном томе:

```bash
gunzip -c ops/deploy/backup/out/guttercaps-<ts>.sqlite.gz > /tmp/restore.sqlite
sqlite3 /tmp/restore.sqlite 'PRAGMA integrity_check; SELECT COUNT(*) FROM events_raw; SELECT MAX(slot) FROM events_raw;'
# затем: остановить api, подменить том, запустить — и дождаться, пока ingest_lag_slots уйдёт в 0
```

Терминальный шаг, который никто не делает и который всё ломает: `events_raw` — источник истины,
проекции пересобираются из него: `docker compose -f ops/deploy/docker-compose.yaml exec api npm --prefix backend run rebuild`. То есть потерять можно projections-таблицы; потерять нельзя
`events_raw` — отсюда и `:ro`-том в сервисе backup (бэкап не может ничего испортить) и обязательная
проверка `integrity_check` на самой копии.

## 5. Масштабирование: что придётся делать руками

Сейчас один писатель SQLite = один `api`-контейнер, и это не временное уродство, а осознанный
выбор topology (см. `backend/src/main.ts`: API + индексор + crank + price-cache в одном процессе).

Второй репликой API можно стать почти сразу — нужны только два условия:

1. `EVENT_BUS=redis` + `REDIS_URL` (иначе `/ws` на второй реплике не увидит события, которые
   записал индексор первой: inproc-шина живёт внутри процесса),
2. `API_INGEST=0` на репликах и один отдельный контейнер-индексор (иначе два индексора будут
   писать в один файл).

А вот это уже упирается в SQLite: crank, pyth-cache и `finality` пишут в те же таблицы. Первым
шагом идёт Postgres: схема уже написана (`backend/prisma/schema.prisma`, 914 строк, 53 модели),
отсутствует порт слоя доступа (`backend/src/db.ts` синхронный, `node:sqlite`) — это отдельная
задача на 3–5 дней, и `docs/09 §4.3` намеренно не считает её «включением переменной».

## 6. Инциденты

### 6.1 «Игрок заплатил и не получил пак»

Единственный алерт, который всегда про деньги: `crank_abandoned_jobs > 0`.

```bash
docker compose -f ops/deploy/docker-compose.yaml logs --since 30m api 2>&1 | grep -iE "crank|ALERT" | tail -20
# только чтение, без зависимостей: образ — node 22, у которого есть встроенный node:sqlite
docker compose -f ops/deploy/docker-compose.yaml exec api node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/guttercaps.sqlite', { readOnly: true });
console.table(db.prepare('SELECT key, phase, attempts, last_error FROM crank_jobs ' +
  'WHERE phase IN (\'pending\',\'stale\',\'settled\',\'abandoned\') ORDER BY updated_at DESC LIMIT 20').all());
"
```

`phase='abandoned'` — исчерпан `CRANK_MAX_ATTEMPTS`: randomness не открылся (шлюз Switchboard или
RPC). Порядок: (1) проверить `pyth_cache_age_seconds` и состояние шлюза, (2) поднять attempts и
вернуть в `pending` **только** если randomness уже готов, (3) иначе — ручной reveal из
`docs/06 §3.3`. Держать игрока в неведении нельзя: `POST /v1/admin/*` пишет `admin_audit`, и
`GET /v1/admin/kpi` показывает очередь. Возврат — `PackCancelled` (окно refund на контракте,
`STALE_PACK_SLOTS`), и это тоже on-chain операция, а не «delete из таблицы».

### 6.2 Покупки паков валятся с StalePrice

Значит price feed старше `PYTH_MAX_AGE_S` (или conf/price больше `PYTH_MAX_CONF_BPS`).

```bash
curl -s localhost:8080/v1/prices | head -c 600        # ageS/healthy по каждому фиду
docker compose -f ops/deploy/docker-compose.yaml logs api --since 30m | grep -iE "pyth|price" | tail
cd ops/pyth-pusher && docker compose logs --since 30m | tail -30   # сам пушер — отдельный проект
```

Частые причины по убыванию вероятности: закончился SOL у payer-ключа (см. `npm run pyth-pusher --
cost`), протух/отозван Hermes-ключ, `PYTH_SOL_ACCOUNT`/`PYTH_SKR_ACCOUNT` указывают не на те
аккаунты, которые пишет *наш* пушер (программа читает аккаунт, а не «последнюю цену» — см.
`programs/chip_core/src/pyth.rs`).

### 6.3 RPC начинает отвечать 429/таймаутами

Симптом: `ingest_lag_slots` растёт, `crank_pending_jobs` растёт, API при этом полностью здоров.
Ничего в коде менять не надо: `listen` имеет heal-цикл (`LISTEN_HEAL_DEPTH`), который добирает
пропущенное сам, как только RPC вернётся. Если lag > 300 и RPC жив — смотреть, не сел ли websocket
(web3.js переподключается сам, а вот подписка на `onLogs` после долгого простоя может и не
вернуться → `docker compose restart api`, он догонит через backfill).

### 6.4 Клиент «показывает пустоту», API зелёный

Проверить, что bundle собран с правильными id (типично после `program-ids -- apply`, когда клиент
пересобрали, а образ нет):

```bash
docker compose -f ops/deploy/docker-compose.yaml exec client sh -c "grep -ho 'G[A-Z0-9]\{30,\}' /usr/share/nginx/html/assets/*.js 2>/dev/null | sort -u | head"
npm run program-ids -- status
```

Не совпало — пересобрать образ клиента (VITE-аргументы — build-time, не runtime: `environment:` в
compose на bundle не влияет, и это ровно то, что проверяет assert в `Dockerfile.client`).

### 6.5 Контейнер вечно перезапускается

Скорее всего `/readyz` даёт 503 во время первичного backfill, а healthcheck вcompose смотрит в
readyz: подними `BACKFILL_START_PERIOD`. `restart: unless-stopped` + `start_period` — это единственная
правильная реакция; «починить» через `--force-recreate` значит перезапустить backfill с нуля.

## 7. Откат версии

`TAG` в `.env` попадает в тег образа, поэтому откат — это смена одного значения, при условии, что
теги пушатся в registry (или что образы не пересобирались на хосте поверх `:local`):

```bash
echo 'TAG=v0.2.3' >> ops/deploy/.env && npm run ops:up
```

Откат по схеме БД невозможен без обратной миграции: `db.ts` умеет только additive-изменения
(`migrate()` добавляет колонки, ничего не удаляет). Значит откат версии совместим тогда и только
тогда, когда между версиями не менялся формат событий. Перед откатом: снять бэкап вручную
(`npm run ops:backup-now`) и проверить `events_raw`-count — если новая версия писала события,
которые старая не декодирует, откат = `npm run backend:rebuild` после отката, а не тихая дырка в лидербордах.

## 8. Перед mainnet (то, что runbook обеспечить не может)

Единственный честный список — `docs/09-production-readiness.md §7` (владелец, не CI): Squads-мультиподпись
и 48 h timelock, отдельный 1/3 pauser, четыре keypair'а кранов, Hermes-ключ и payer пушера, RPC с
WS/Geyser, Turnstile-ключи, Sentry/uptime, домены, юридическое заключение + финальный арт, казначейство
на мультиподпись. Плюс G-0: реальный `anchor build` + `cargo test` + localnet-сюжеты на машине с
тулчейном и сетью (в этой песочнице их не было — см. `docs/08`), и прогон E2E на devnet.
