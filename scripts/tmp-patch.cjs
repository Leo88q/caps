const fs = require('fs');
const root = '/home/user/caps/';

// 1. server.ts: seed the process-level series that the alert rules query.
let s = fs.readFileSync(root + 'backend/src/server.ts', 'utf8');
const anchor = "  registerScrape('metrics_series',";
const add = "  // Seeded at 0 on boot, *here*, because a counter that only exists after the first crash cannot be\n"
  + "  // used by `increase(process_crashes_total[15m]) > 0`: Prometheus has no previous sample to compare\n"
  + "  // to, so the alert would fire on the second crash and stay green through the first. Any process that\n"
  + "  // serves /metrics carries the baseline, whoever imports the shutdown module.\n"
  + "  metrics.counter('process_crashes_total', undefined, 0);\n"
  + anchor;
if (!s.includes(anchor)) throw new Error('server anchor missing');
s = s.replace(anchor, add, 1);
fs.writeFileSync(root + 'backend/src/server.ts', s);

// 2. shutdown.ts: keep the comment accurate about who seeds the series.
let k = fs.readFileSync(root + 'backend/src/shutdown.ts', 'utf8');
const oldC = k.slice(k.indexOf('// One unlabeled counter'), k.indexOf('const metricsAlert = () =>'));
const newC = "// One unlabeled counter, incremented here and seeded by `createApp` (which owns the /metrics contract):\n"
  + "// a per-`kind` label would make every crash a *new* series whose first sample can never be an `increase`,\n"
  + "// so the alert in ops/monitoring/alerts.yml would fire on the second crash instead of the first.\n";
if (!oldC.includes('const metricsAlert')) throw new Error('shutdown anchor missing');
k = k.replace(oldC, newC, 1);
fs.writeFileSync(root + 'backend/src/shutdown.ts', k);
console.log('patched');
