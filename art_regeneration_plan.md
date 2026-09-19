# 🎯 План доведения арта до 100% (72/72) — регенерации, остатки, промты, форматы

> **СМЕНА ОБЪЁМА (2026-09-19, решение владельца):** коллекции 09 (тату) и 08 (велокурьеры) исключены → 8 коллекций / 72 мастера. Всё присланное перегенерируется ИИ по этому плану; §5 (пересдача 74) отменена — её закрывает регенерация; промты §4 для района 09 отменены. Черновики 01-4 / 04-5 / 05-5 / 06-5 / 07-2 выпущены (18-я партия).

**Дата:** 2026-09-19. **Принято в журнал: 74 / 90. Осталось создать: 16 кадров + 3 регенерации + пересдача мастеров.**
Источник лора: `packages/economy/src/lore.ts`. Спецификация: `docs/07-art-spec.md`. Протокол приёмки: `art/README.md`.

---

## 1. Формат мастера — требования к КАЖДОМУ кадру (сайт + игра + NFT)

Художник сдаёт **один мастер-файл**; всё остальное (фон NFT-карточки, свечение, тень, нарезка) делает пайплайн. Правила из `docs/07-art-spec.md` §2:

| Параметр | Требование |
|---|---|
| Файл | **PNG-32 (RGBA)**, 8 бит/канал, **sRGB** (профиль sRGB IEC61966-2.1; никакого Display-P3/Adobe RGB) |
| Холст | квадрат **2048×2048** (мин. 1600, лучше 4096) |
| Диск | ровный круг **строго сверху** (0° наклона, ортографично), Ø **1792 px = 87,5 % холста**, центр в центре; прозрачное поле по 128 px с каждой стороны |
| Альфа | снаружи диска — 0; **внутри диска — 255 везде** (никаких полупрозрачных «стёкол» и вырезов); край чёткий, антиалиасинг 1–2 px |
| Запрещено в мастере | фон, тень, внешнее свечение, виньетка за диском (всё это печёт пайплайн — иначе в игре задвоится с CSS-свечением) |
| Текст | никакого читаемого текста (имя/редкость рисует UI на локалях); граффити-леттеринг как элемент арта — можно |
| IP | никаких узнаваемых персонажей/логотипов/реальных объектов (§2) |
| Исходник | + файл со слоями (PSD/Procreate/Figma/Affinity) — для правок и анимаций тиров 6–8 |

**Зоны внутри диска** (R = 896 px при 2048): 100–92 % — обод; 92–70 % — фактура (сюда ложатся бейджи UI — без ключевых деталей на диагоналях); **70–30 % — сюжет** (читается на 130 px); 30–0 % — центр (видно на 56 px).

**Чек перед сдачей:** уменьшить до 130 px и 56 px → должны различаться силуэт, цвет района, материал обода. Один доминирующий силуэт, ≤ 3 доминирующих цвета, контраст сюжет/подложка ≥ 4:1, линии ≥ 6 px.

**Тон лица диска:** тёмное семейство asphalt `#16151A…#2A2830` (светлый диск выжигает тёмную сетку игры).

**Материал обода — лестница по тиру (§3), единая для всех коллекций:**

| Тир | Обод |
|---|---|
| 0 Common | цинк, поцарапанный, матовый |
| 1 Common+ | цинк, мокрый блеск |
| 2 Rare | полированная сталь |
| 3 Rare+ | сталь, «бензиновая плёнка» |
| 4 Epic | эмаль, magenta |
| 5 Epic+ | эмаль-кракле, orange |
| 6 Legend | бронза с патиной |
| 7 Legend+ | бронза, светящаяся acid |
| 8 Diamond | призма/голограмма, хром |

**Цвета районов (lore.ts):** 01 cyan `#16E5D9` · 02 orange `#FF7A1A` · 03 magenta `#FF2E8A` · 04 trust `#9AD9FF` · 05 acid `#B6FF3C` · 06 cyan · 07 magenta · 08 orange · 09 trust `#9AD9FF` (запрещён `#2E8BFF` — цвет денег UI) · 10 acid.

**Именование файла мастера:** `master/{район:02}-{тир}.png` → например `03-4.png` (Rail Kings, Epic), `09-8.png` (Inked Streets, Diamond).

---

## 2. Базовый шаблон промта (подставлять сцену)

```
Top-down orthographic game asset: a round bottle-cap disc, perfectly centered on a
2048×2048 transparent canvas, disc diameter 87.5% of canvas, crisp edge, alpha 0
outside / 255 inside. Dark asphalt disc face (#16151A–#2A2830). [СЦЕНА].
One dominant silhouette readable at 130 px, ≤3 dominant colors, [ЦВЕТ РАЙОНА] accent.
Rim: [МАТЕРИАЛ ОБОДА ПО ТИРУ]. Gritty texture INSIDE the disc only. No background,
no shadow, no glow, no baked text, no logos, no real-world brands or likenesses.
Style: [СТИЛЬ РАЙОНА].
```

Negative prompt (всегда): `background, shadow, glow, vignette, text, watermark, logo, brand, tilted coin, ellipse, 3D perspective, translucent holes, pastel light face`.

---

## 3. Полная регенерация — 🔴 3 кадра (блокеры)

### 3.1 `04-5` «One-Storm Batch — Second Wave» (Epic+, район 04)
**Почему:** swoosh Nike + фигурка на язычке (IP-блокер), лор «Second Wave» не читается, светло-лиловое лицо.
**Промт:**
```
Another pair from the same named storm: worn sneakers mid-restore on a cobbler workbench
under a rain-streaked basement window, wet asphalt reflections, one pair already stitched
with a bold orange thread seam, a second pair waiting — "an extra batch from the same storm".
Fixed-gear courier city mood, rain and storm-glass mood, teal-blue #9AD9FF accent thread.
Dark asphalt face #16151A–#2A2830, rim: crackle orange enamel. Absolutely no brand logos,
no swoosh-like marks — side stripes are plain abstract leather panels.
```

### 3.2 `05-5` «Two MCs, One Mic — Rematch» (Epic+, район 05)
**Почему:** рукопашный бой вместо рэп-баттла; фигуры читаются как Брюс Ли + боец из файтинга (юридический блокер).
**Промт:**
```
Street rap-battle rematch: two MC silhouettes in streetwear caps face off across ONE
microphone on a stand between them, a semicircle of crowd silhouettes with raised hands
around the disc edge, sound-wave lines from the mic, night lamppost mood.
Acid-yellow #B6FF3C accent + magenta secondary on dark asphalt face (#16151A–#2A2830).
Rim: crackle orange enamel. Stylized anonymous silhouettes only — no recognizable
persons, no martial arts, no gi/uniforms, no real brand clothing.
```

### 3.3 `06-5` «The Raccoon Squad — Second Raid» (Epic+, район 06)
**Почему:** хоррор-демоны вместо «того же экипажа» енотов; противоречит тону коллекции («не злодеи — духи улиц»).
**Промт:**
```
The SAME three raccoons from the accepted frame 06-4 (same faces, same markings), now on
a second raid: dumpster lid tipped open, one raccoon inside passing loot out, one carrying
a trash-bag haul, one keeping watch — mischievous street-spirit mood, teamwork and timing.
Glossy dark-green enamel sticker style matching 06-4, cyan #16E5D9 accent, steam from
a manhole in background of the scene. Dark asphalt face variant (#16151A–#2A2830),
rim: crackle orange enamel. Friendly tricksters, NOT monsters, no horror, no fangs.
```

Отклонённый кадр без ключа (кроссовок-«наклейки» с Chuck Taylor, район 10) — **снимается с учёта**: его роль закрывают новые промты 10-4/10-5 (§4).

---

## 4. Оставшиеся 16 кадров — сцены и промты

### Район 01 «Ночной Мотылёк» — 1 кадр (стиль серии: чёрный + жёлтый трафарет)

**`01-4` «Moth Behind Bars» (Epic)** — «работа, о которой спорил весь квартал».
⚠️ Отличие от уже принятого 01-5: **без даты и подписи** (01-5 — «The Record», датирован и подписан).
```
A stencil moth silhouette trapped behind thick vertical prison bars painted across the
disc, the bars cutting the wings into slices, one wing pressing against a bar — the image
the whole block argued about. Single-layer yellow #FFD400-ish stencil accent on dark
asphalt face (#16151A–#2A2830), spray texture, one paint drip. Rim: magenta enamel (tier 4).
No date, no signature, no letters.Anonymous street-art mood.
```

### Район 07 «Пиксельный Подвал» — 1 кадр (стиль: тёмные экраны, неон, пиксель)

**`07-2` «Secret Level» (Rare)** — «скрытый уровень, который не должны были найти».
⚠️ Пара с 07-3 «…Second Route» (неоновая дверь): тир 2 должен показать **сам уровень на экране**, а не вход.
```
A dark CRT arcade screen filling the disc face, scanlines and slight curvature glow:
on-screen pixel-art of a hidden basement level just revealed — a secret corridor opening
behind a cracked pixel wall, treasure room glowing magenta #FF2E8A with cyan #16E5D9
details, tiny player sprite frozen at the entrance. Reflection of the room on the glass.
Dark asphalt face, rim: polished steel (tier 2). No readable words on screen —
score/labels rendered as abstract pixel blocks.
```

### Район 10 «Городские Мифы» — 5 кадров (стиль: коллаж из рваной бумаги, тёмные тона, acid-акцент)

**`10-2` «Legend, Written Down» (Rare)** — «история, которую кто-то наконец записал».
```
Torn-paper collage: a lone figure under a streetlamp writing in a notebook — a hand with
a pen, notebook page with abstract scribble-lines (no readable words), torn city-map
fragments and photos of the neighborhoods layered around; the legend becoming text.
Cold blue night tones + acid #B6FF3C accents on dark asphalt face (#16151A–#2A2830),
rim: polished steel (tier 2). Real collage texture, torn edges, paper shadows inside the disc.
```

**`10-3` «Legend, Written Down — Footnote» (Rare+)** — «тот же рассказ, с новыми деталями».
```
THE SAME notebook scene as 10-2, now with pinned footnotes: small torn paper notes with
stars and marks pinned around the page, red-string connections, one new taped photo
fragment adding a detail that wasn't in the first telling. Same cold blue + acid #B6FF3C
palette, dark asphalt face, rim: steel with petrol film (tier 3). No readable text.
```

**`10-4` «Where Two Stories Cross» (Epic)** — «момент, где пересекаются легенды двух районов».
Два узнаваемых мифа в одном кадре (основной вариант — мотылёк 01 + призрачная гонка 08):
```
Two city legends crossing in one frame: a cyan-glowing moth silhouette (Night Moth legend)
flying LOW over a long yellow ghost light-trail (the Ghost Race legend) — the trail and
the moth's path intersect in the disc center, torn-paper collage sky behind, streetlamp.
Dark asphalt face #16151A–#2A2830, acid #B6FF3C + cyan accents, rim: magenta enamel (tier 4).
Collage torn-paper edges. Both legends must be recognizable at 130 px.
```
Альтернатива: бумбокс района 05, стоящий на люке, из которого валит пар «тварей» 06.

**`10-5` «Where Two Stories Cross — A Third District» (Epic+)** — «то же пересечение + третий район».
```
Same crossing as 10-4 — cyan moth over the yellow ghost light-trail — now joined by a
THIRD legend: a boombox on the corner emitting acid sound-waves (Boombox Block legend).
Three legend-elements visibly converging at one point of the disc, torn-paper collage,
dark asphalt face, acid #B6FF3C + cyan + magenta accents, rim: crackle orange enamel (tier 5).
```

**`10-7` «The Night the City Didn't Sleep — Again?» (Legend+)** — «неподтверждённый слух о второй ночи».
⚠️ Пара с 10-6 (карта города, пины в янтарной смоле): здесь та же карта, но «слуховая».
```
The same city map under torn paper as 10-6, but DOUBLED and unreliable: a second fainter
map layer misprinted behind the first, pins flickering, one district pin duplicated
off-position, a question-mark-shaped light leak — a rumor of a second impossible night
nobody can confirm. Amber resin connections now semi-transparent. Dark asphalt face,
acid #B6FF3C accents, rim: glowing acid bronze (tier 7). Exactly nine district pins.
```

### ~~Район 09 «Inked Streets» — 9 кадров~~ — 🗑 ОТМЕНЕНО (коллекция исключена владельцем 2026-09-19)
Стиль района: тату-культура; цвет `#9AD9FF` (запрещён `#2E8BFF`); мотивы: свежая татуировка на коже, машинка/ручная набивка, кожаная книга-регистратура мастера. Общий хвост промта: `Dark asphalt disc face (#16151A–#2A2830). No readable text. No real studio names.`

**`09-0` «First Mark» (Common, обод: поцарапанный цинк)**
```
A small simple first tattoo: a tiny linework star-anchor, freshly inked, slight redness
around the lines, on a patch of skin rendered inside the disc; minimalist, "just a start".
Ink black + light blue #9AD9FF accent.
```
**`09-1` «First Mark — Touch-Up» (Common+, цинк с мокрым блеском)**
```
THE SAME small star-anchor mark, now extended: a second short line-element added, ink
freshened, slight gloss of healing ointment — same spot, grown a little.
```
**`09-2` «Block Brand» (Rare, полированная сталь)**
```
A bold geometric neighborhood brand: a crown-over-gutter angular emblem in classic black
tattoo linework with light blue #9AD9FF fill accents — the mark that says which blocks
you belong to. Clean geometry, reads at 56 px.
```
**`09-3` «Block Brand — Retraced» (Rare+, сталь «бензиновая плёнка»)**
```
THE SAME geometric brand, retraced and deepened: thicker confident lines, added shading,
slight raised-heal texture — gone over by the artist a second time.
```
**`09-4` «Hand-Poked Piece» (Epic, эмаль magenta)**
```
A full hand-poked stick-and-poke piece: dotwork swallow-and-dagger motif, every dot
visible, imperfect in a human way, made by the master himself; the hand-poke needle rest
beside the skin patch. Dark, intimate lamplight mood.
```
**`09-5` «Hand-Poked Piece — Second Sitting» (Epic+, эмаль-кракле orange)**
```
THE SAME dotwork piece, finished a month later: second-sitting shading visible next to
the older faded dots, the piece now complete — two sittings readable as two ink ages.
```
**`09-6` «The Master's Ledger» (Legend, бронза с патиной)**
```
The founder's private ledger: an open leather-bound book page with a small tattoo drawing,
an abstract name-line and a wax-confirmed mark — a confirmed entry in the book that started
the chain-of-custody idea. Warm lamplight, dust, brass corner fittings. No readable words —
handwriting rendered as abstract strokes.
```
**`09-7` «The Master's Ledger — Second-to-Last Page» (Legend+, светящаяся acid бронза)**
```
The same ledger, now almost full: pen resting in the fold, only one blank line left at the
bottom of the page, earlier entries faded — the parlor is about to close. Melancholic
golden-hour mood, bronze glow at the page edge.
```
**`09-8` «Invisible Ink» (Diamond, призма/хром)**
```
UV blacklight reveal: the disc shows ordinary bare skin under normal light, and under a
UV lamp from above a large hidden design FLARES into glowing light-blue ink — a tattoo
that only appears years later, under the right light. Prism-hologram chrome rim, cyan-white
UV glow, subtle star sparkles. The reveal is the story.
```

---

## 5. ~~Пересдача 74 принятых кадров~~ — 🗑 ОТМЕНЕНО: вместо пересдачи ВСЕ кадры перегенерируются ИИ (см. смену объёма в шапке)

Все принятые кадры — «презентационные»: с запечённым фоном/тенью и текстом на ободе. Для пайплайна нужен чистый мастер (§1). Работы по группам:

### 5.1 Техническая пересдача — ВСЕ 74
- вырезать диск в прозрачность, ортографично, Ø 87,5 % холста (или пересдать исходники со слоями);
- убрать фон/тень/свечение/виньетку (печёт пайплайн);
- текст на ободе — убрать весь (имя/редкость рисует UI);
- проверить тест 130 px / 56 px.

### 5.2 Убрать «1/1» (заявление о саплае, контракт минтит по редкости) — 9 кадров
`02-8, 03-8, 04-8, 05-8, 06-8, 07-8, 08-8, 10-8, 01-8`

### 5.3 Тёмный вариант лица (§2.2) — сделать вариант с лицом `#16151A…#2A2830` или тёмную подложку
`02-1, 02-3, 02-4, 02-5, 05-2, 05-7, 08-1, 06-0, 04-0, 04-1, 04-5(новый уже тёмный), 04-7, 01-0, 01-2, 01-6, 03-2, 07-6(граница)`

### 5.4 Нейтрализация IP / реальных объектов
| Кадр | Что убрать/заменить |
|---|---|
| 04-5 | регенерация (§3.1) |
| 04-6 | swoosh на боковине → нейтральная полоса |
| 03-4 | силуэт ЭР2 → абстрактный freight-вагон; горы/сосны → городские планы Gutter City |
| 10-8 | скайлайн реального города → абстрактный Gutter City |
| 01-5 | год «2024» → внутримировая дата или убрать |
| 08-0 | полосатый флаг с кантоном → клетчатый чекпоинт-флаг |
| 1788877583824c | снят с учёта (§3) |

### 5.5 Сюжетные правки 🟡 (точечные)
| Кадр | Правка |
|---|---|
| 02-7 | бинт перенести с руки на **ногу**; портрет → сцена трюка (ряд серии) |
| 05-1 | пересдать рендером ≥1600² (сейчас скриншот из 3D-пакета) |
| 05-3 | согласовать серию: если «один предмет — девять слоёв» — ок; иначе брейкер вместо бумбокса |
| 05-6 | переснять подложку без чужих стикеров (SKATE/RAD/1984) |
| 05-8 | добавить приметы «первой вечеринки» (гирлянда, стаканы, мел на асфальте) |
| 06-1 | тот же голубь, что 06-0 (силуэт + циановый глаз), а не реалистичный |
| 06-3 | коту — один глаз (повязка/шрам), связка с 06-2 |
| 06-4 | добавить мусорный контейнер из лора |
| 06-7 | добавить белую королеву из 06-6; цыплят → серые голубиные птенцы |
| 07-1 | кадр → квадрат, монету внутрь диска |
| 07-5 | убрать капли воды с лица |
| 08-3 | сигнал светофора янтарный → **красный** (тир «Ran the Red») |
| 08-5 | добавить курьерский мотив (силуэт фикса в кислотном вихре) |
| 10-1 | связать с 10-0: та же стена/та же фигура («один слух в двух пересказах») |
| 10-6 | светящихся пинов ровно **9** (по числу районов) |
| 10-8 | замкнуть петлю на район 01: мотылёк/циан в кадре |
| 03-1 | общий элемент руки с 03-0 (узнаваемость «того же райтера») |
| 03-2 | сделать надпись читаемой или усилить масштаб «burner» |
| 03-8 | добавить на борт работу, которую «не закрасили» (рука серии); решить freight vs пассажирский |
| 04-2 | убедиться: нитей **две параллельные** |
| 04-3 | усилить «третий проход» нити |
| 04-4 | показать «партию» (несколько пар), а не одну пару |
| 04-7 | пара вместо одного кроссовка (или зафиксировать «нашся только один» как решение) |
| 08-5 | см. 08-5 выше |
| 08-7 | ок — «пустой циферблат» осознанный (правок нет) |

---

## 6. Открытые решения владельца (без них финал не закрыть)

1. **Нить района 04:** оранжевая (как на кадрах) или голубая `#9AD9FF` (как `lore.color`)?
2. **Обода:** жёсткая лестница §3 (цинк→сталь→эмаль→бронза→хром) или материал свободен? Сейчас почти везде сталь.
3. **`lore.color` vs кадры:** 01 кадры жёлто-красные (lore — cyan), 03 разнобой (lore — magenta), 05 фиолет/оранж (lore — acid). Править `lore.ts` или перекрашивать кадры?
4. **«Один кислотный акцент» (библия):** в 01-3 и 01-5 жёлтый + красный одновременно. Канон?
5. **07-2 vs 07-3:** дверь (сейчас 07-3) остаётся «Second Route», а новый 07-2 покажет уровень на экране? (иначе поменять местами)
6. **Стилистические регистры:** 07 (пиксель-арт vs «физические экраны»), 03 (фото-граффити vs эмаль), 04 (макро-неон vs тихие гравюры) — унифицировать при нормализации или оставить «разные подвалы/мастерские»?
7. **Пассажирский транспорт в 03:** 03-4/03-8 — пассажирские поезда при freight-лоре. Канон или замена?
8. **04-7:** «нашся только один» — осознанное чтение или пересдача с парой?

---

## 7. Порядок работ (рекомендация)

1. **Регенерации 🔴** (04-5, 05-5, 06-5) — блокеры, начать с них.
2. **16 новых кадров** — по промтам §4 (батчами по 5: 09-0…09-4 → 09-5…09-8+01-4 → 07-2+10-2…10-5 → 10-7).
3. **Пересдача мастеров 74 кадров** — параллельно, по районам (§5); удобно совмещать с сюжетными правками 5.5.
4. **Решения владельца** (§6) — зафиксировать до нормализации, чтобы не переделывать дважды.
5. После каждой партии: я сверяю с лором и чек-листом §1, записываю в журнал `art/manifest.json` + трекер.

---

## 8. Прогресс выполнения

Скоуп: 8 коллекций / 72 мастера (09 и 08 исключены владельцем).

- [x] 01-4, 04-5, 05-5, 06-5, 07-2 — черновики выпущены (18-я партия)
- [ ] Подтверждение владельцем черновиков
- [x] Район 01: 7/9 регенов готовы (0,1,3,4,5,6,7); ⏳ 01-2 (портфель) и 01-8 (лужа) — очередь следующего хода
- [ ] 02 — 9 кадров · [ ] 03 — 9 кадров · [ ] 04 — 8 · [ ] 05 — 8 · [ ] 06 — 8 · [ ] 07 — 8
- [ ] 10 — 4 регена (10-0/1/6/8) + 5 новых (10-2/3/4/5/7)
- [ ] Нормализация: рим-лестница §3 применена при генерации; связки пар — сверка после всех батчей
- [ ] Финальный QA: тест 130/56 px, палитры, экспорты пайплайна
