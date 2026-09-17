# Веб-шрифты: self-host, не CDN

Причина, по которой `client/index.html` больше не тянет Google Fonts: `ops/deploy/nginx.conf` отдаёт
`style-src 'self' 'unsafe-inline'; font-src 'self' data:`. Внешний `<link>` с googleapis.com блокируется
этим же CSP — то есть в проде шрифт и так не грузился, а запрос (с IP посетителя) уходил на каждую
загрузку страницы. Плюс это render-blocking CSS вне нашего origin: он ломает и бюджет `docs/06` §1.3, и
наш собственный текст в `/legal/privacy` про то, кому что уходит.

## Что положить в эту папку

| файл | источник | где используется |
|---|---|---|
| `permanent-marker-latin.woff2` | Permanent Marker 400 | заголовки, `.logo-mark`, `--cg-font-display` |
| `rubik-wet-paint-latin.woff2` | Rubik Wet Paint 400 | второй дисплейный в цепочке |
| `inter-400-latin.woff2` … `inter-700-latin.woff2` | Inter 400/500/600/700 | основной текст |
| `jetbrains-mono-400-latin.woff2` … `-600-` | JetBrains Mono 400/500/600 | числа, адреса, цены |

Подмножества: `latin` обязателен, `latin-ext` — для vi/de/fr/es/pt, `cyrillic` — для ru. CJK (ja/ko)
намеренно не скачивается: у Permanent Marker нет этих глифов, и `theme.css` уже держит fallback-цепочку
(`docs/08` §5 — про fallback на другие графики). Оба семейства распространяются под OFL — файл `OFL.txt`
кладём рядом с шрифтами, это требование лицензии, а не перестраховка.

Размер: четыре начертания Inter + три JetBrains Mono + два дисплейных ≈ 120–160 КБ woff2 на подмножество.
В бюджет критического пути это не входит (`npm run bundle:check` считает JS/CSS из entry-графа), но входит
в `total-byte-weight` в Lighthouse — поэтому preload'им только то, что видно первым экраном.

## Что добавить в `client/src/shared/ui/theme.css`

```css
@font-face {
  font-family: 'Permanent Marker';
  src: url('/fonts/permanent-marker-latin.woff2') format('woff2');
  font-weight: 400; font-style: normal; font-display: swap;
}
/* …аналогично остальным; блок @font-face ставится до :root,
   чтобы var(--cg-font-display/-body/-mono) их уже видели… */
```

`font-display: swap` обязателен: без него Lighthouse флагает `font-display` (в `lighthouserc.cjs` он стоит
в `error`), а на 4G текст до загрузки шрифта невидим.

Отдача: `ops/deploy/nginx.conf` уже раздаёт `/fonts/` как статикy с `font/woff2` и long-cache — файлы из
`public/` попадают в `dist/` хешем в имени только у JS/CSS, поэтому шрифтам нужен `immutable` по mime
(проверить заголовки после выкладки: `curl -I https://app…/fonts/inter-400-latin.woff2`).

## ## Куда смотреть, если шрифт «снова ходит вовне»

`<link>` в HTML — только один из трёх каналов. Сборка вырезает удалённые `@import` из CSS зависимостей и
удалённые `<link>`-теги из их JS (`noThirdPartyAssets` в `client/vite.config.ts`), а `npm run bundle:check`
ищет off-origin и в `dist/*.css`, и в `dist/*.js`. Если зависимость начала тянуть шрифт новым способом —
чинить надо это правило, а не ослаблять проверку.

## Проверка после добавления

```bash
npm run e2e:mock        # ни один запрос не должен уходить за пределы origin (mock-shell.spec.ts)
npm run lhci            # render-blocking-resources + font-display
```
