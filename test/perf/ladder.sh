#!/usr/bin/env bash
# سلّم ضغط: بيشغّل k6 بعدد مستخدمين متزايد ويطبع جدول (p95 / p99 / طلبات/ثانية / نسبة الأخطاء) لتحديد نقطة التباطؤ.
# الاستخدام: test/perf/ladder.sh [BASE] [DURATION]   (يتطلب k6 و jq أو python3)
set -euo pipefail
BASE="${1:-http://127.0.0.1:4173}"; DUR="${2:-15s}"; OUT="$(mktemp -d)"
printf '%-6s %-9s %-9s %-9s %-9s %-8s %s\n' VUs reqs rps p95_ms p99_ms err% thresholds
for v in 10 25 50 100 200 400; do
  k6 run -q -e BASE="$BASE" -e VUS="$v" -e DURATION="$DUR" --summary-export "$OUT/$v.json" test/perf/load.js >/dev/null 2>&1 && ok=PASS || ok=FAIL
  python3 - "$OUT/$v.json" "$v" "$ok" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))['metrics']; v=sys.argv[2]
dur=d['http_req_duration']; r=d['http_reqs']; f=d['http_req_failed']
print(f"{v:<6} {int(r['count']):<9} {r['rate']:<9.1f} {dur['p(95)']:<9.1f} {dur['p(99)']:<9.1f} {f['value']*100:<8.2f} {sys.argv[3]}")
PY
done
