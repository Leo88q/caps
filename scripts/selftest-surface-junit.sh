#!/bin/sh
# selftest-surface-junit.sh — проверка ci-surface-junit.sh на трёх формах отчёта: настоящая раскладка vitest
# (внешний <testsuites> + по элементу <testsuite> на файл), отказы с позицией и переполнение лимита, и два
# случая, когда отчёта нет. Текстовые проверки, а не коды возврата: скрипт обязан выходить 0 ВСЕГДА, так что
# по коду возврата нельзя отличить «аннотации правильные» от «аннотаций нет вовсе» — а именно это и есть
# единственная опасная поломка для шага, который работает под `if: failure()`.
#
# Песочница — temp-каталог самого скрипта. В прошлый раз фикстура, написанная в корень репозитория, оставила
# там же поддельный Cargo.lock, и он уехал в коммит (docs/09 §1.4): файлы тестов не должны иметь шанса попасть
# в дерево проекта.
set -u

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
surface="$root/ci-surface-junit.sh"
box=$(mktemp -d) || exit 1
trap 'rm -rf "$box"' EXIT INT TERM

checks=0
fails=0
scen=0

ok() { checks=$((checks + 1)); }
no() { checks=$((checks + 1)); fails=$((fails + 1)); printf 'not ok — %s\n' "$1"; printf '        ожидалось: %s\n' "$2"; }

# $1 = подстрока, которую надо найти; $2 = описание; $3 = файл с выводом
has() {
  if grep -qF -- "$1" "$3"; then ok; else no "$2" "в выводе есть «$1»"; fi
}
hasnt() {
  if grep -qF -- "$1" "$3"; then no "$2" "в выводе НЕТ «$1»"; else ok; fi
}
count() {  # $1 = паттерн (ERE), $2 = ожидали N строк, $3 = описание, $4 = файл
  n=$(grep -cE -- "$1" "$4" 2>/dev/null || true)
  n=$(printf '%s' "$n" | tr -dc '0-9')
  [ -n "$n" ] || n=0
  if [ "$n" -eq "$2" ]; then ok; else no "$3" "$1 встречается $2 раз(а), а нашлось $n"; fi
}

[ -f "$surface" ] || { echo "не найден ci-surface-junit.sh рядом с этим скриптом"; exit 1; }

# ---------------------------------------------------------------- сценарий A: форма vitest, всё пропущено
scen=$((scen + 1))
cat > "$box/real-junit.xml" <<'XML'
<testsuites name="vitest tests" tests="83" failures="0" errors="0" time="1.442">
  <testsuite name="tests/localnet/00-admin.spec.ts" timestamp="x" hostname="h" tests="9" failures="0" errors="0" skipped="9" time="0">
    <testcase classname="tests/localnet/00-admin.spec.ts" name="init создаёт GameConfig"><skipped/></testcase>
  </testsuite>
  <testsuite name="tests/localnet/10-packs.spec.ts" timestamp="x" hostname="h" tests="29" failures="0" errors="0" skipped="29" time="0">
    <testcase classname="tests/localnet/10-packs.spec.ts" name="buy_pack резервирует ренту"><skipped/></testcase>
  </testsuite>
  <testsuite name="tests/localnet/60-cross.spec.ts" timestamp="x" hostname="h" tests="4" failures="0" errors="0" skipped="4" time="0">
    <testcase classname="tests/localnet/60-cross.spec.ts" name="burn report feeds emission"><skipped/></testcase>
  </testsuite>
</testsuites>
XML
sh "$surface" "$box/real-junit.xml" > "$box/a.out" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok || no "сценарий A: rc 0" "exit 0, получен $rc"
has "surfacing real-junit: 83 test(s), 0 failure(s), 0 error(s), 42 skipped" \
    "A: итоги берутся из внешнего <testsuites>, а skipped суммируется по файлам" "$box/a.out"
hasnt "::error" "A: пропущенный прогон не печатает ошибок" "$box/a.out"

# ---------------------------------------------------------------- сценарий B: отказы с позицией и экранированием
scen=$((scen + 1))
cat > "$box/fail-junit.xml" <<'XML'
<testsuites name="vitest tests" tests="83" failures="2" errors="1" time="9.1">
  <testsuite name="10-packs" tests="83" failures="2" errors="1" skipped="0">
    <testcase classname="10-packs" name="opens a premium pack" time="0.4">
      <failure message="expected 4 chips after open&#10;actual 3">AssertionError: expected 4 chips after open
actual 3
 --&gt; tests/localnet/10-packs.spec.ts:412:9
    at Object.&lt;anonymous&gt; (tests/localnet/10-packs.spec.ts:412:9)</failure>
    </testcase>
    <testcase classname="tests/localnet/40-arena.spec.ts" name="resolves a battle" time="0.2">
      <failure message="read 0x1234 Custom &quot;ProgramError&quot; &#10; --> tests/localnet/40-arena.spec.ts:77:5">  --> tests/localnet/40-arena.spec.ts:77:5</failure>
    </testcase>
    <testcase classname="60-cross" name="burn report feeds emission">
      <error message="thread panicked in 100% coverage of nothing"/>
    </testcase>
  </testsuite>
</testsuites>
XML
sh "$surface" "$box/fail-junit.xml" > "$box/b.out" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok || no "сценарий B: rc 0" "exit 0, получен $rc"
count '^::error ' 3 "B: три отдельных аннотации (два failure + один error)" "$box/b.out"
has 'file=tests/localnet/10-packs.spec.ts,line=412,title=fail-junit opens a premium pack' \
    "B: позиция из тела отказа и ИМЯ ТЕСТА в заголовке (не имя classname/suite)" "$box/b.out"
has 'file=tests/localnet/40-arena.spec.ts,line=77' "B: позиция из classname" "$box/b.out"
has '%0A' "B: перевод строки экранирован как %0A" "$box/b.out"
hasnt '%250A' "B: %25 не применяется к уже вставленным %0A (иначе читается %250A)" "$box/b.out"
has 'title=fail-junit burn report feeds emission::thread panicked in 100%25 coverage of nothing' \
    "B: литеральный % удваивается, &quot; остаётся кавычкой, error-элемент читается" "$box/b.out"
# имя теста не должно обрезаться: ровно этот дефект давал `10-pack` вместо `opens a premium pack`
hasnt 'title=fail-junit 10-packs::' "B: в заголовке имя теста, а не classname без последней буквы" "$box/b.out"
count '^::notice' 1 "B: строка учёта одна, и она говорит правду" "$box/b.out"
has 'surfacing fail-junit: 83 test(s), 2 failure(s), 1 error(s), 0 skipped' "B: итоги из внешнего элемента" "$box/b.out"

# ---------------------------------------------------------------- сценарий C: переполнение лимита
scen=$((scen + 1))
{
  printf '<testsuite tests="15" failures="15" errors="0" skipped="0">\n'
  i=1
  while [ "$i" -le 15 ]; do
    printf '  <testcase classname="s%d.spec.ts" name="case %d"><failure message="boom %d">stack %d</failure></testcase>\n' "$i" "$i" "$i" "$i"
    i=$((i + 1))
  done
  printf '</testsuite>\n'
} > "$box/many-junit.xml"
sh "$surface" "$box/many-junit.xml" > "$box/c.out" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok || no "сценарий C: rc 0" "exit 0, получен $rc"
count '^::error ' 12 "C: аннотаций ровно столько, сколько можно послать (cap 12)" "$box/c.out"
has '3 more failure(s) not annotated' "C: остаток назван числом, а не промолчан" "$box/c.out"

# ---------------------------------------------------------------- сценарий D: отчёта нет / отчёт мусор
scen=$((scen + 1))
printf 'не xml вовсе\n' > "$box/garbage-junit.xml"
sh "$surface" "$box/garbage-junit.xml" "$box/absent-junit.xml" > "$box/d.out" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok || no "D: rc 0 даже на мусоре и отсутствующем файле" "exit 0, получен $rc"
has 'no junit report' "D: отсутствующий файл — отдельная ошибка, а не пустой вывод" "$box/d.out"
has 'Do not read this as "no tests failed"' "D: текст объясняет, чего не надо из этого выводить" "$box/d.out"
count '^::error ' 1 "D: отсутствующий файл — ровно одна ошибка" "$box/d.out"
count '^::notice' 1 "D: учёт печатается для прочитанного отчёта; для отсутствующего его не бывает (скрипт
     продолжает цикл сразу после ошибки — иначе «0 failure(s)» рядом с «отчёта нет» читалось бы как успех)" "$box/d.out"

if [ "$fails" -eq 0 ]; then
  printf 'selftest ok: ci-surface-junit.sh — %s проверок по %s сценариям (раскладка vitest, позиция и имя в аннотации, экранирования, cap, отсутствие отчёта)\n' "$checks" "$scen"
  exit 0
fi
printf 'selftest FAILED: ci-surface-junit.sh — %s из %s проверок не прошли\n' "$fails" "$checks"
exit 1
