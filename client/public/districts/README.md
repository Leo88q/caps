# Баннеры районов (district banners)

Широкие сцены для шапок районов в Кодексе (`/districts/{num}.jpg`,
8 шт: 01–07 + 10 — лаунч-вселенная, № 08–09 вырезаны).

Исходники — `art_drafts/site/banner-{num}.png`; паблик-версии ужаты до
≤ 1200 px, JPEG q70 (`convert banner-X.png -resize 1200x1200\> -quality 70
-strip X.jpg`). В Кодексе кадрируются CSS (`height 150/110 px, object-fit: cover`).
