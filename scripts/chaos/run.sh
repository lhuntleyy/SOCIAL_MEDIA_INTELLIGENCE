#!/usr/bin/env bash
# H-02 chaos suite (single-node compose). Memaksa beberapa pengambilan murah (X xquik + YouTube gratis) lalu:
#   A. restart Redis antrean   B. ClickHouse mati 60 dtk   C. worker dimatikan di tengah pengambilan
# dan memeriksa invarian (scripts/chaos/invariants.ts). Gangguan ± 5 menit → jalankan di luar jam pakai.
#   pakai: scripts/chaos/run.sh [--env infra/compose/.env.dev] [--only A|B|C]
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=infra/compose/.env.dev; ONLY=""
while [ $# -gt 0 ]; do case "$1" in --env) ENV_FILE=$2; shift 2 ;; --only) ONLY=$2; shift 2 ;; *) shift ;; esac; done
run() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
set -a; . "$ENV_FILE"; set +a
export PATH="$HOME/.bun/bin:$PATH"
DOCKER="docker"; docker ps >/dev/null 2>&1 || DOCKER="sg docker -c docker"
P=${COMPOSE_PROJECT:-smip-dev}
inv() { bun scripts/chaos/invariants.ts; }
force() { # jadwalkan segera plan X & YouTube aktif (murah/gratis)
  bun -e 'import postgres from "postgres"; const s = postgres(process.env.DATABASE_URL!); const r = await s.begin(async (t) => { await t`SET LOCAL ROLE smip_system`; return t`update crawl_plans set next_run_at = now() where status = ${"active"} and platform_code in ${s(["x", "youtube"])} returning id`; }); console.log("dipaksa", r.length, "plan"); await s.end();'
}
wait_s() { echo "… tunggu $1 dtk"; sleep "$1"; }
echo "== awal"; BEFORE=$(inv); echo "$BEFORE"

A=$BEFORE; B=$BEFORE; C=$BEFORE
if run A; then
  echo "== A. restart Redis antrean"
  force; wait_s 5
  $DOCKER restart "$P-redis-queue-1" >/dev/null
  wait_s 120; A=$(inv); echo "$A"
fi
if run B; then
  # ClickHouse dimatikan DULU lalu pengambilan dipaksa → hasil fetch tiba saat ClickHouse mati → sink wajib retry (bukan hilang/dobel)
  echo "== B. ClickHouse mati 90 dtk saat data masuk"
  $DOCKER stop "$P-clickhouse-1" >/dev/null
  force
  wait_s 90
  $DOCKER start "$P-clickhouse-1" >/dev/null
  wait_s 180; B=$(inv); echo "$B"
fi
if run C; then
  echo "== C. worker dimatikan di tengah pengambilan"
  force; wait_s 3
  $DOCKER restart "$P-workers-1" >/dev/null
  wait_s 180; C=$(inv); echo "$C"
fi

python3 - "$BEFORE" "$A" "$B" "$C" <<'PY'
import json, sys
b, *steps = [json.loads(x) for x in sys.argv[1:]]
ok = True
for name, s in zip("ABC", steps):
    bad = []
    if not isinstance(s["dup_events"], int) or s["dup_events"] > b["dup_events"]: bad.append(f"dup_events {b['dup_events']}→{s['dup_events']}")
    if s["dlq"] > b["dlq"]: bad.append(f"dlq {b['dlq']}→{s['dlq']}")
    if s["outbox_pending"] > 5: bad.append(f"outbox_pending {s['outbox_pending']}")
    print(f"{name}: {'LULUS' if not bad else 'GAGAL ' + '; '.join(bad)}  (run sukses 10m={s['runs_ok_10m']}, gagal 10m={s['runs_failed_10m']}, terbuka={s['runs_open']})")
    ok &= not bad
sys.exit(0 if ok else 1)
PY
