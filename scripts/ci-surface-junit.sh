#!/bin/sh
# ci-surface-junit.sh <junit-xml>… — publish test failures as annotations, for readers who cannot open the log.
#
# Why: the localnet job is the one place where a failure is *many* failures (83 scenarios across five
# programs), and the useful part is not "vitest exited 1" but which specs failed with which assertion. The job
# log — where that lives — is unreachable from a terminal (`gh api …/actions/jobs/<id>/logs` returns an empty
# reply; ci-surface-log.sh carries the whole story), so the report has to leave through the annotations API
# instead. The junit XML is the machine-readable summary of the run that already happened, so this reads that
# rather than re-running anything.
#
# Deliberate limits, each a trade and not an oversight:
#   * at most $MAX failures, one annotation each, plus a `::notice` line with the totals — because a check run
#     silently drops annotations past an undocumented budget, and 83 red specs would be cut at an unknown
#     point. The accounting line is what keeps "cut off" distinguishable from "that was all of them".
#   * the per-test annotations are capped at $MAX, so one more line carries the *shape* of every failure: the
#     first line of each message with pubkeys / hex / numbers masked, grouped and counted. "61 failure(s) in N
#     shape(s)" is what makes the capped detail readable as a whole (the 35361217764 run annotated 12 of 61,
#     and in 35363245120 the API returned 1 of those 12 while the aggregate survived — hence: shapes first,
#     details second, and the number of unannotated failures repeated in the aggregate).
#   * escaping and the cap have exactly one workable order: `%` must be doubled before any literal `%0A` is
#     introduced (the other order prints `%250A`, which is what the first version of flat() did), the raw text
#     is capped with headroom for the growth, and the result never ends on a bare `%` (a truncated escape).
#     An annotation message truncates at 3201 characters, so 1260 leaves room for the key=value properties.
#   * `file=`/`line=` point at the spec when the record names one, at ci.yml:1 when it does not — an
#     annotation attached to nothing is worse than one that says "look near the workflow".
#   * this script must never fail: it runs under `if: failure()`, and a reporting step that dies on a
#     malformed XML turns a diagnosis into a second mystery. So everything non-printing is `|| true`, unknown
#     attributes become empty strings, and the exit is unconditional.
#   * the awk program below is delimited by single quotes for the shell, so it contains no apostrophes at all
#     (not in comments either: an apostrophe in a comment ends the program, and dash then reports
#     `Syntax error: "(" unexpected` three lines away from the cause). The field separator inside the pipeline
#     is 0x1f written as an *octal* awk escape — hex is a gawk extension, and where it is unsupported the
#     record comes out joined by the literal text "x1f", which prints as an annotation with an empty title.
set -u

# Per-test detail lines. 6, not 12: a check run keeps only a handful of annotations per job (run 35363245120
# emitted 12 detail lines and exactly one of them came back through the API, while the summary lines did), so
# the budget is spent on the shapes line first and a short window of details second.
MAX=6

i=0
for report in "$@"; do
  i=$((i + 1))
  name=$(basename "$report" .xml)
  if [ ! -s "$report" ]; then
    printf '::error title=%s: no junit report,file=.github/workflows/ci.yml,line=1::%s is missing or empty — the suite produced no XML, so either it died before writing the report or the reporter is not configured. Do not read this as "no tests failed".\n' "$name" "$report"
    continue
  fi

  # totals from the <testsuite> attributes: they belong in the accounting line, because "12 annotated" without
  # "23 failures" reads like the whole report.
  # vitest writes <testsuites tests="83" …> around one <testsuite tests="9" …> per spec file, so the totals
  # must come from the plural element — reading them from the last singular line was a report that said
  # "4 test(s)" about a suite of 83, which is the same class of lie as a gate that counts `head -1`.
  # `skipped` exists only on the singular elements, so that one is summed instead.
  totals=$(awk -F'"' '
    /<testsuites / { agg = 1 }
    /<testsuites / { for (k = 1; k <= NF; k++) {
        if ($(k-1) ~ /tests=$/)    t = $k
        if ($(k-1) ~ /failures=$/) f = $k
        if ($(k-1) ~ /errors=$/)   e = $k } }
    /<testsuite /  { for (k = 1; k <= NF; k++) {
        if ($(k-1) ~ /skipped=$/)  s += $k
        if (!agg && $(k-1) ~ /tests=$/)    t2 = $k
        if (!agg && $(k-1) ~ /failures=$/) f2 = $k
        if (!agg && $(k-1) ~ /errors=$/)   e2 = $k } }
    END { if (agg) printf "%d %d %d %d", t+0, f+0, e+0, s+0
          else     printf "%d %d %d %d", t2+0, f2+0, e2+0, s+0 }' "$report" 2>/dev/null || true)
  # shellcheck disable=SC2086  # splitting the four numbers apart is the whole point of the line above
  set -- $totals
  tcount=${1:-0}; fcount=${2:-0}; ecount=${3:-0}; scount=${4:-0}

  # Shape histogram, published BEFORE the per-test lines: $MAX of 61 failures is a window, and a window
  # cannot answer "how many distinct things are broken". A shape is the first line of the message with
  # the volatile parts masked — pubkeys become <pk>, numbers <n>, hex <hex> — so "expected anchor
  # ConstraintHasOne (2001), got 6001 from <pk>" is one row no matter which program said it. One line,
  # not a per-shape annotation: this is the index that says which of the detailed ones to read.
  # It is printed first even though it is computed from the same records, because the annotation budget is
  # not ours to choose: in run 35363245120 GitHub handed back 1 of the 12 detail annotations and dropped the
  # other 11, while the summary lines survived. The aggregate is the line worth protecting.
  # RS is a string, not a regex (mawk): without it the records are LINES, and vitest puts raw newlines
  # inside `message` — the shape then reads as "(no message in the report)" for every failure.
  hist=$(awk -v RS='</testcase>' -v TOP=6 -v MAX="$MAX" '
    function attr(rec, a,   key, p, q) {
      key = " " a "=\""
      p = index(rec, key); if (!p) return ""
      p += length(key); q = index(substr(rec, p), "\""); if (!q) return ""
      return substr(rec, p, q - 1)
    }
    function unent(v) {
      gsub(/&#13;/, "", v); gsub(/&#10;/, "\n", v); gsub(/&lt;/, "<", v); gsub(/&gt;/, ">", v)
      gsub(/&quot;/, "\"", v); gsub(/&#39;/, "\047", v); gsub(/&amp;/, "&", v)
      return v
    }
    # Base58 keys are masked by RUN LENGTH, not by a `{32,44}` interval: the CI awk is mawk, and
    # mawk 1.3.4 without `-W re-interval` treats `{n,m}` as literal text, so an interval silently matches
    # nothing — the first version of this function did exactly that and left every pubkey readable.
    # Runs are scanned with `+` and the length is judged in awk instead.
    # A digit run glued to a letter is an identifier, not a volatile number: `AssetV1`, `u32`, `G01` and
    # `sha256` must survive masking (the first version turned them into `AssetV<n>`, `u<n>`), while error
    # codes, amounts and line numbers are free-standing and do get masked.
    # `next` is an awk reserved word and cannot be a parameter name (a syntax error that only shows up as a
    # silently empty histogram, because the caller redirects awk stderr) — the neighbour is `after` here.
    function masknums(v,   out, p, run, rs, prev, after) {
      out = ""
      p = 1
      while (match(substr(v, p), /[0-9]+/)) {
        rs = p + RSTART - 1
        run = substr(v, rs, RLENGTH)
        prev = (rs > 1 ? substr(v, rs - 1, 1) : "")
        after = substr(v, rs + RLENGTH, 1)
        if (prev ~ /[A-Za-z]/ || after ~ /[A-Za-z]/) out = out substr(v, p, rs - p + RLENGTH)
        else out = out substr(v, p, rs - p) "<n>"
        p = rs + RLENGTH
      }
      return out substr(v, p)
    }
    function mask(v,   out, p, run, rs) {
      out = ""
      p = 1
      while (match(substr(v, p), /[1-9A-HJ-NP-Za-km-z]+/)) {
        rs = p + RSTART - 1
        run = substr(v, rs, RLENGTH)
        out = out substr(v, p, rs - p) (length(run) >= 32 ? "<pk>" : run)
        p = rs + RLENGTH
      }
      out = out substr(v, p)
      v = out
      gsub(/0x[0-9a-fA-F]+/, "<hex>", v)
      v = masknums(v)
      if (length(v) > 110) v = substr(v, 1, 110) "..."
      return v
    }
    index($0, "<failure") || index($0, "<error") {
      tag = ""; rest = $0
      while (match(rest, /<testcase[^>]*>/)) { tag = substr(rest, RSTART, RLENGTH); rest = substr(rest, RSTART + RLENGTH) }
      cls = attr(tag != "" ? tag : $0, "classname")
      msg = unent(attr($0, "message"))
      if (msg == "") msg = "(no message in the report)"
      split(msg, lines, "\n")
      shape = mask(lines[1])
      count[shape]++
      total++
      if (!(shape in ex)) {
        # the position is looked for in `classname`, then in the whole record: the spec often appears only
        # in the failure body (vitest writes the suite name into `classname` for some files), and reporting
        # a shape without a place to look would just move the question down the page.
        pos = ""
        if (match(cls, /[A-Za-z0-9._\/-]*\.spec\.[jt]sx?/)) pos = substr(cls, RSTART, RLENGTH)
        if (pos == "" && match($0, /[A-Za-z0-9._\/-]*\.spec\.[jt]sx?/)) pos = substr($0, RSTART, RLENGTH)
        line = "1"
        if (pos != "" && match($0, /:[0-9]+/)) line = substr($0, RSTART + 1, RLENGTH - 1)
        ex[shape] = (pos != "" ? pos ":" line : "the spec is not named in the record")
      }
    }
    END {
      n = 0
      for (k in count) keys[++n] = k
      for (i = 2; i <= n; i++) { k = keys[i]; c = count[k]; j = i - 1
        while (j > 0 && count[keys[j]] < c) { keys[j + 1] = keys[j]; j-- }
        keys[j + 1] = k }
      m = (n < TOP ? n : TOP)
      out = ""
      for (i = 1; i <= m; i++) { k = keys[i]
        out = out (i > 1 ? " | " : "") count[k] "x " k " @ " ex[k] }
      if (n > TOP) out = out " | +" (n - TOP) " more shape(s)"
      # the same count the per-test loop reports, carried here too: this line is the one that survives when
      # the detail annotations do not, and "18 failures, 6 shown" must not read as "18 failures, all shown".
      if (total > MAX) out = out " | +" (total - MAX) " more failure(s) not annotated (cap " MAX ")"
      printf "%d\t%d\t%s", total, n, out
    }
  ' "$report" 2>/dev/null || true)
  htot=$(printf '%s' "$hist" | cut -f1)
  hshapes=$(printf '%s' "$hist" | cut -f2)
  htext=$(printf '%s' "$hist" | cut -f3 | cut -c1-1200)
  if [ -n "$htext" ]; then
    printf '::error file=%s,line=1,title=%s failure shapes::%s failure(s) in %s shape(s): %s\n' \
      ".github/workflows/ci.yml" "$name" "${htot:-$fcount}" "${hshapes:-?}" "$htext" || true
    # and in the step summary, which has no cap of its own: the UI keeps it next to the job, and a reader
    # who cannot open the log gets the same index there as in the annotation.
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      printf '### %s — failure shapes\n\n%s failure(s) in %s shape(s): %s\n' \
        "$name" "${htot:-$fcount}" "${hshapes:-?}" "$htext" >> "$GITHUB_STEP_SUMMARY" || true
    fi
  fi

  # One record per `</testcase>`; keep the ones carrying a failure or an error. Emitted line:
  # classname US name US spec US line US message, already escaped, so the loop never re-reads the file.
  awk -v RS='</testcase>' -v MAX="$MAX" '
    # Attribute lookup. Two ways it must NOT be done, both seen in the first versions of this file:
    # index(rec, "name=\"") also matches inside `classname="`, which returned the spec file as the test name;
    # and arithmetic on a regex match length dropped the last character of every value. A leading space is
    # the delimiter that makes the attribute name unambiguous, and the value ends at the next quote.
    function attr(rec, a,   key, p, q) {
      key = " " a "=\""
      p = index(rec, key)
      if (!p) return ""
      p += length(key)
      q = index(substr(rec, p), "\"")
      if (!q) return ""
      return substr(rec, p, q - 1)
    }
    function unent(v) {
      gsub(/&#13;/,  "",   v)   # CRs survive as entities and buy nothing but a broken reader
      gsub(/&#10;/,  "\n", v)
      gsub(/&lt;/,   "<",  v)
      gsub(/&gt;/,   ">",  v)
      gsub(/&quot;/, "\"",  v)
      gsub(/&#39;/,  "\047", v)
      gsub(/&amp;/,  "&",   v)  # last: the substitutions above may have introduced new ampersands
      return v
    }
    function flat(v) {
      gsub(/\r/, "", v)
      gsub(/%/, "%25", v)       # BEFORE the %0A below, or the escape we insert gets escaped again
      gsub(/\n/, "%0A", v)
      v = substr(v, 1, 1260)    # 1200 raw plus headroom for both substitutions above
      if (substr(v, length(v), 1) == "%") v = substr(v, 1, length(v) - 1)
      return v
    }
    index($0, "<failure") || index($0, "<error") {
      if (out >= MAX) { over++; next }
      # the LAST `<testcase …>` in the record is ours: RS=</testcase> makes a record begin after the previous
      # one, so its head still carries `<testsuite name="localnet" …>`
      tag = ""; rest = $0
      while (match(rest, /<testcase[^>]*>/)) { tag = substr(rest, RSTART, RLENGTH); rest = substr(rest, RSTART + RLENGTH) }
      if (tag == "") tag = $0
      cls = attr(tag, "classname"); nm = attr(tag, "name")
      msg = unent(attr($0, "message"))
      # the body usually repeats the message as the first line of a diff, so keep the body whenever there is
      # one: it is where the `--> spec.ts:412:9` position lives. The first version joined only when the
      # message was NOT contained in the body, which threw the position away.
      body = $0
      if (match(body, /message="[^"]*"[^>]*>/))       body = substr(body, RSTART + RLENGTH)
      else if (match(body, /<(failure|error)[^>]*>/)) body = substr(body, RSTART + RLENGTH)
      if (match(body, /<\/(failure|error)/))           body = substr(body, 1, RSTART - 1)
      body = unent(body)
      gsub(/^[ \t\n]+|[ \t\n]+$/, "", body)
      full = msg
      if (body != "") { if (msg == "" || index(body, msg) > 0) full = body; else full = msg " | " body }
      # position: vitest puts the spec in `classname` or in the body; the line follows the path
      fp = ""; ln = "1"
      if (match(cls, /[A-Za-z0-9._\/-]*\.spec\.[jt]sx?/)) fp = substr(cls, RSTART, RLENGTH)
      else if (match(full, /tests\/[A-Za-z0-9._\/-]*\.spec\.[jt]sx?/)) fp = substr(full, RSTART, RLENGTH)
      if (fp != "" && match(full, fp ":[0-9]+")) ln = substr(full, RSTART + length(fp) + 1, RLENGTH - length(fp) - 1)
      out++
      printf "%s\037%s\037%s\037%s\037%s\n", flat(cls), flat(nm), fp, ln, flat(full)
    }
    END {
      if (over) printf "\037\037\037\037+ %d more failure(s) not annotated (cap %d); the junit report attached to this run has all of them\n", over, MAX
    }
  ' "$report" 2>/dev/null |
    while IFS= read -r rec; do
      fld() { printf '%s' "$1" | awk -F'\037' -v n="$2" '{ print $n }'; }
      cls=$(fld "$rec" 1) || cls=""
      nm=$(fld "$rec" 2)  || nm=""
      spec=$(fld "$rec" 3) || spec=""
      ln=$(fld "$rec" 4)   || ln="1"
      msg=$(fld "$rec" 5) || msg=""
      [ -n "$nm" ] || nm="$cls"
      [ -n "$msg" ] || msg="(the report carries no message for this case)"
      case "$msg" in
        "+ "*) printf '::warning title=%s::%s\n' "$name" "${msg#+ }" || true; continue ;;
      esac
      if [ -n "$spec" ]; then
        printf '::error file=%s,line=%s,title=%s %s::%s\n' "$spec" "$ln" "$name" "$nm" "$msg" || true
      else
        printf '::error file=.github/workflows/ci.yml,line=1,title=%s %s::%s\n' "$name" "$nm" "$msg" || true
      fi
    done || true

  printf '::notice::surfacing %s: %s test(s), %s failure(s), %s error(s), %s skipped; up to %s annotated\n' \
    "$name" "$tcount" "$fcount" "$ecount" "$scount" "$MAX" || true

done
exit 0
