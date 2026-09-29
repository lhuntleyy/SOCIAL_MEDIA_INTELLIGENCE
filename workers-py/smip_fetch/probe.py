"""health.probe untuk connector runtime python (diteruskan worker-fetch-bun lewat `fetch.py`, review 2026-09-30).
Hasil dicatat di audit_logs; circuit breaker tetap digerakkan trafik nyata (probe unofficial = pasif, CONNECTOR_SPEC §8.2)."""
from __future__ import annotations

import asyncio
from typing import Any

from .accounts import AuditWriter, ProbeTargets
from .connector import ConnectorContext
from .errors import ConnectorError
from .execute import FetchDeps

PROBE_TIMEOUT_S = 30.0


async def run_health_probe(d: FetchDeps, targets: ProbeTargets, audit: AuditWriter, payload: dict[str, Any]) -> dict[str, Any]:
    cid = str(payload["connector_id"])
    found = await targets(cid)
    if found is None:
        return {"status": "not_found", "results": []}
    key, accounts = found
    conn = d.connectors.get(key)
    if conn is None:
        await audit("connector.health_check.result", cid, {"job_id": payload.get("job_id"), "status": "NOT_SUPPORTED_BY_RUNTIME", "runtime": "python"})
        return {"status": "unsupported", "results": []}
    loop = asyncio.get_running_loop()
    results: list[dict[str, Any]] = []
    for acc_id in accounts:
        try:
            m = await d.accounts(acc_id, cid)
            ctx = ConnectorContext(
                credential=m.credential,
                config=m.config,
                logger=d.logger,
                deadline=loop.time() + PROBE_TIMEOUT_S,
                report_rate_limit=lambda _i: None,
                archive_raw=lambda _p, _m: asyncio.sleep(0, "probe://tidak-diarsip"),
            )
            r = await asyncio.wait_for(conn.health_probe(ctx), PROBE_TIMEOUT_S)
            results.append({"account_id": acc_id, "ok": r.ok, "latency_ms": r.latency_ms, **({"error_code": r.error_code} if r.error_code else {})})
        except ConnectorError as e:
            results.append({"account_id": acc_id, "ok": False, "latency_ms": 0, "error_code": e.code})
        except asyncio.TimeoutError:
            results.append({"account_id": acc_id, "ok": False, "latency_ms": int(PROBE_TIMEOUT_S * 1000), "error_code": "TIMEOUT"})
    await audit("connector.health_check.result", cid, {"job_id": payload.get("job_id"), "results": results, "runtime": "python"})
    return {"status": "done", "results": results}
