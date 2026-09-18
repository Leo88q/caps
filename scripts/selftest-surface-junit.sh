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
count '^::error ' 4 "B: три отдельных аннотации (два failure + один error) плюс строка форм" "$box/b.out"
has '3 failure(s) in 3 shape(s)' "B: сводка по формам считает все отказы, а не только аннотированные" "$box/b.out"
has '1x expected <n> chips after open' "B: форма отказа маскирует числа" "$box/b.out"
has '1x read <hex> Custom' "B: форма отказа маскирует hex" "$box/b.out"
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
count '^::error ' 7 "C: 6 отдельных аннотаций (cap) плюс строка форм" "$box/c.out"
has '9 more failure(s) not annotated' "C: остаток назван числом, а не промолчан" "$box/c.out"
hpos=$(grep -n 'failure shapes' "$box/c.out" | head -1 | cut -d: -f1)
dpos=$(grep -n ',title=many-junit case' "$box/c.out" | head -1 | cut -d: -f1)
[ -n "$hpos" ] && [ -n "$dpos" ] && [ "$hpos" -lt "$dpos" ] \
  && ok || no "C: строка форм идёт ПЕРВОЙ" "агрегат на строке ${hpos:-нет}, первая подробность на ${dpos:-нет}"
has '| +9 more failure(s) not annotated (cap 6)' "C: остаток продублирован в строке форм — она выживает, когда подробности нет" "$box/c.out"
has '15 failure(s) in 1 shape(s)' "C: строка форм видит ВСЕ 15 отказов, включая те, что не влезли в cap" "$box/c.out"
has '15x boom <n>' "C: 15 отказов одной формы — одна строка с числом, а не 15 повторов" "$box/c.out"

# ---------------------------------------------------------------- сценарий E: формы группируют отказы
scen=$((scen + 1))
{
  printf '<testsuite tests="8" failures="8" errors="0" skipped="0">\n'
  i=1
  while [ "$i" -le 5 ]; do
    printf '  <testcase classname="tests/localnet/00-admin.spec.ts" name="case %d"><failure message="expected anchor::ConstraintHasOne (2001), got 6001 from GCRhrg6mc7zH1VdXG5rX3tQEpgu8Gptf27vdsJGV7G8q&#10; --> tests/localnet/00-admin.spec.ts:9%d:5">x</failure></testcase>\n' "$i" "$i"
    i=$((i + 1))
  done
  printf '  <testcase classname="tests/localnet/50-staking.spec.ts" name="oracle revokes"><failure message="expected anchor::ConstraintHasOne (2001), got 6001 from GCuGx7fnLcKnw1NWU4dLzQvnJWggMVniQ4u7EuMaQevA&#10; --> tests/localnet/50-staking.spec.ts:440:5">x</failure></testcase>\n'
  printf '  <testcase classname="tests/localnet/60-cross.spec.ts" name="buy"><failure message="buy failed: Access violation in stack frame 5 at address 0x200005ff8 of size 8&#10; --> tests/localnet/60-cross.spec.ts:92:5">x</failure></testcase>\n'
  printf '  <testcase classname="tests/localnet/00-admin.spec.ts" name="G01"><failure message="RangeError: Offset is outside the bounds of the DataView u32 AssetV1&#10; --> tests/localnet/00-admin.spec.ts:51:5">x</failure></testcase>\n'
  printf '  <testcase classname="tests/localnet/00-admin.spec.ts" name="G02"><failure message="Not a Core AssetV1&#10; --> tests/localnet/00-admin.spec.ts:52:5">x</failure></testcase>\n'
  printf '</testsuite>\n'
} > "$box/shapes-junit.xml"
sh "$surface" "$box/shapes-junit.xml" > "$box/e.out" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok || no "сценарий E: rc 0" "exit 0, получен $rc"
# шесть одинаковых по смыслу отказов (разные программы и номера строк) — одна форма, счёт 6
has '6x expected anchor::ConstraintHasOne (<n>), got <n> from <pk>' "E: один смысл — одна форма (разные ключи и строки)" "$box/e.out"
has '9 failure(s) in 4 shape(s)' "E: четыре формы на девять отказов" "$box/e.out"
has '@ tests/localnet/00-admin.spec.ts:91' "E: у формы есть пример места" "$box/e.out"
has '@ tests/localnet/00-admin.spec.ts:91 [case 1]' "E: у формы назван тест, который её показывает" "$box/e.out"
has 'Access violation in stack frame <n> at address <hex> of size <n>' "E: маскировка адреса и размера" "$box/e.out"
has 'Not a Core AssetV1' "E: короткие сообщения не превращаются в мусор" "$box/e.out"
has 'RangeError: Offset is outside the bounds of the DataView' "E: идентификаторы с цифрами не портятся (u32, AssetV1, DataView)" "$box/e.out"

# ---------------------------------------------------------------- сценарий G: позиция из СВОЕГО теста
scen=$((scen + 1))
# vitest пишет прошедшие тесты самозакрывающимися `<testcase ... />`, поэтому запись (RS='</testcase>')
# несёт в начале все предыдущие кейсы. Позицию формы нужно искать только в элементе текущего отказа,
# иначе пример укажет на файл и строку соседнего теста — и читатель пойдёт не туда.
{
  printf '<testsuite tests="2" failures="1" errors="0" skipped="0">\n'
  printf '  <testcase classname="tests/localnet/00-admin.spec.ts" name="passing" time="0.4" />\n'
  printf '  <testcase classname="tests/localnet/10-packs.spec.ts" name="C13 refund" time="0.5">'
  printf '<failure message="cancel_stale_pack failed: TransactionErrorInstructionError { index: 1, error: ExternalAccountLamportSpend }">'
  printf 'Program log: Instruction: CancelStalePack\n --&gt; tests/localnet/10-packs.spec.ts:167:13</failure></testcase>\n'
  printf '</testsuite>\n'
} > "$box/selfcase-junit.xml"
sh "$surface" "$box/selfcase-junit.xml" > "$box/g.out" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok || no "сценарий G: rc 0" "exit 0, получен $rc"
has '} @ tests/localnet/10-packs.spec.ts:167 [C13 refund]' \
  "G: позиция и имя берутся из своего теста, а не из предыдущего самозакрытого" "$box/g.out"

# ---------------------------------------------------------------- сценарий F: переводы строк в message
scen=$((scen + 1))
# Ровно то, что пишет vitest: `message` содержит сырые переводы строк (хвост логов программы), поэтому
# awk обязан читать отчёт записями по `</testcase>`, а не построчно — иначе форма пуста у всех отказов.
{
  printf '<testsuite tests="2" failures="2" errors="0" skipped="0">\n'
  printf '  <testcase classname="tests/localnet/60-cross.spec.ts" name="X01"><failure message="TxFailure: buy failed: TransactionErrorInstructionError { index: 1, error: ProgramFailedToComplete }\nProgram GCA2aUeX7ZFbGz3zvjqvsbjD1G3QjWxLhBpK5jwwPdcz failed: Access violation in stack frame 5 at address 0x200005ff8 of size 8\n --&gt; tests/localnet/60-cross.spec.ts:92:21">x</failure></testcase>\n'
  printf '  <testcase classname="tests/localnet/50-staking.spec.ts" name="S23"><failure message="Error: kind 9 is not an item root — use claimRootIx / claimSkrRootIx\n --&gt; tests/localnet/50-staking.spec.ts:455:38">x</failure></testcase>\n'
  printf '</testsuite>\n'
} > "$box/multiline-junit.xml"
sh "$surface" "$box/multiline-junit.xml" > "$box/f.out" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok || no "сценарий F: rc 0" "exit 0, получен $rc"
has '2 failure(s) in 2 shape(s)' "F: обе формы посчитаны, ни одна не «(no message)»" "$box/f.out"
has 'TxFailure: buy failed' "F: форма берётся из первой строки message" "$box/f.out"
has 'TxFailure: buy failed: TransactionErrorInstructionError { index: <n>, error: ProgramFailedToComplete }' \
    "F: форма — первая строка message, с маскированными числами (адрес живёт ниже и попадёт в аннотацию)" "$box/f.out"
has '@ tests/localnet/60-cross.spec.ts:92' "F: место отказа — из тела message, а не «:1»" "$box/f.out"
hasnt '(no message in the report)' "F: пустая форма не появляется там, где message есть" "$box/f.out"

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
  printf 'selftest ok: ci-surface-junit.sh — %s проверок по %s сценариям (раскладка vitest, позиция и имя в аннотации, экранирования, cap, формы отказов, многострочный message, позиция из своего теста, отсутствие отчёта)\n' "$checks" "$scen"
  exit 0
fi
printf 'selftest FAILED: ci-surface-junit.sh — %s из %s проверок не прошли\n' "$fails" "$checks"
exit 1
