"""Satu job `fetch.py` = satu ATTEMPT pada satu connector — cermin apps/worker-fetch-bun/src/execute.ts.

Semua sub-query × halaman berurutan (pageLimit per sub-query, maxItems total, deadline_at). Item unik per attempt →
JSONL.gz di blob store → items_ref. Error di tengah jalan: item yang sudah diterima TETAP diteruskan (sudah dibayar).
executeFetch TIDAK PERNAH melempar: semua kegagalan menjadi `outcome=error` di fetch.result (router yang memutuskan).
"""
from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from pydantic import ValidationError
from smip_contracts import CanonicalItem, Envelope, FetchRequestPayload, FetchResultPayload

from .accounts import AccountLoader
from .blobs import BlobStore
from .connector import BaseConnector, ConnectorContext, FetchRequest, Query, RateLimitInfo
from .errors import ConnectorError, to_connector_error
from .redact import redact


def uuid7() -> str:
    """UUIDv7 (RFC 9562): 48-bit ms + versi 7 + varian 10 — sama dengan Bun.randomUUIDv7()."""
    ms = int(time.time() * 1000)
    b = bytearray(ms.to_bytes(6, "big") + secrets.token_bytes(10))
    b[6] = (b[6] & 0x0F) | 0x70
    b[8] = (b[8] & 0x3F) | 0x80
    h = b.hex()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fetch_result_key(crawl_run_id: str, attempt_no: int, part: int) -> str:
    return f"run.{crawl_run_id}.attempt.{attempt_no}.result{f'.{part}' if part else ''}"


def envelope(type_: str, idempotency_key: str, tenant_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
    env = {
        "v": 1,
        "type": type_,
        "id": uuid7(),
        "idempotency_key": idempotency_key,
        "tenant_id": tenant_id,
        "created_at": utc_now_iso(),
        "trace": {},
        "payload": payload,
    }
    Envelope.model_validate(env)  # kontrak sama dengan TS (F-07)
    return env


class SessionLock:
    """Akun sesi login (cookie/session) dipakai SATU worker pada satu waktu — dua login paralel = pola bot (CONNECTOR_SPEC §8)."""

    _RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"

    def __init__(self, redis: Any, prefix: str = "") -> None:
        self._r = redis
        self._prefix = prefix

    async def acquire(self, account_id: str, owner: str, ttl_ms: int) -> bool:
        return bool(await self._r.set(f"{self._prefix}lock:session:{account_id}", owner, nx=True, px=max(1000, ttl_ms)))

    async def release(self, account_id: str, owner: str) -> None:
        await self._r.eval(self._RELEASE, 1, f"{self._prefix}lock:session:{account_id}", owner)


@dataclass
class FetchDeps:
    connectors: dict[str, BaseConnector]
    accounts: AccountLoader
    blobs: BlobStore
    logger: Any
    session_lock: SessionLock | None = None
    on_rate_limit: Callable[[str, RateLimitInfo], Any] | None = None
    now: Callable[[], float] = time.time


async def execute_fetch(d: FetchDeps, raw: dict[str, Any]) -> dict[str, Any]:
    msg = FetchRequestPayload.model_validate(raw)
    r = msg.request
    t0 = d.now()
    loop = asyncio.get_running_loop()
    usage: dict[str, Any] = {"requests": 0, "results": 0, "costUnits": None, "costUnitLabel": None}
    items: dict[str, dict[str, Any]] = {}
    dropped = 0
    rate: RateLimitInfo | None = None
    error: ConnectorError | None = None
    last_cursor: str | None = None
    has_more = False
    secrets_seen: list[str] = []
    part = msg.resume.seq if msg.resume else 0
    lock_owner: str | None = None
    account_id = str(msg.provider_account_id)
    deadline_at = datetime.fromisoformat(str(msg.deadline_at).replace("Z", "+00:00")).timestamp()
    remaining = deadline_at - d.now()
    deadline = loop.time() + max(0.0, remaining)

    def report_rate(i: RateLimitInfo) -> None:
        nonlocal rate
        rate = i
        if i.retry_after_ms and d.on_rate_limit:
            asyncio.ensure_future(d.on_rate_limit(account_id, i))

    try:
        conn = d.connectors.get(msg.connector_key)
        if conn is None:
            raise ConnectorError("NOT_SUPPORTED", f"connector {msg.connector_key} tidak terdaftar di worker ini", scope="connector")
        if msg.resume:
            raise ConnectorError("NOT_SUPPORTED", "connector Python tidak mendukung resume async", scope="connector")
        if remaining <= 0:
            raise ConnectorError("TIMEOUT", "deadline_at sudah lewat sebelum mulai")
        acc = await d.accounts(account_id, str(msg.connector_id))
        secrets_seen = [v for v in acc.credential.secret.values() if isinstance(v, str)]
        if conn.manifest.exclusive_session and d.session_lock:
            lock_owner = f"{msg.crawl_run_id}.{msg.attempt_no}"
            if not await d.session_lock.acquire(account_id, lock_owner, int(remaining * 1000) + 5000):
                lock_owner = None
                raise ConnectorError("RATE_LIMITED", "sesi akun sedang dipakai worker lain", scope="account", retry_after_ms=5000)

        async def archive(page: Any, m: dict[str, Any]) -> str:
            return await d.blobs.put_jsonl(f"raw/{m['platform']}/{msg.crawl_run_id}/{msg.attempt_no}-{m.get('page', 1)}-{uuid7()}.jsonl.gz", [page])

        ctx = ConnectorContext(
            credential=acc.credential,
            config=acc.config,
            logger=d.logger,
            deadline=deadline,
            report_rate_limit=report_rate,
            archive_raw=archive,
        )
        queries: list[Query | None] = [Query(q.native, list(q.sourceNodeIds)) for q in (r.queries or [])] or [None]
        window = r.window
        for qi, q in enumerate(queries):
            if len(items) >= r.maxItems:
                break
            cursor = r.cursor
            for page in range(1, r.pageLimit + 1):
                if len(items) >= r.maxItems:
                    break
                if ctx.expired():
                    raise ConnectorError("TIMEOUT", "deadline attempt terlampaui")
                req = FetchRequest(
                    request_id=uuid7(),
                    idempotency_key=f"{r.idempotencyKey}.q{qi}.page.{page}",
                    platform=str(r.platform.root if hasattr(r.platform, "root") else r.platform),
                    operation=str(r.operation.value if hasattr(r.operation, "value") else r.operation),
                    page_limit=r.pageLimit,
                    max_items=r.maxItems - len(items),
                    query=q,
                    target_ids=list(r.targetIds) if r.targetIds else None,
                    since=str(window.since) if window and window.since else None,
                    until=str(window.until) if window and window.until else None,
                    cursor=cursor,
                )
                try:
                    res = await asyncio.wait_for(conn.fetch(req, ctx), timeout=max(0.001, ctx.remaining()))
                except asyncio.TimeoutError:
                    raise ConnectorError("TIMEOUT", "deadline attempt terlampaui") from None
                usage["requests"] += res.usage.requests
                usage["results"] += res.usage.results
                if res.usage.cost_units is not None:
                    usage["costUnits"] = (usage["costUnits"] or 0) + res.usage.cost_units
                usage["costUnitLabel"] = usage["costUnitLabel"] or res.usage.cost_unit_label
                for it in res.items:
                    try:
                        CanonicalItem.model_validate(it)
                    except ValidationError:
                        dropped += 1
                        continue
                    items[f"{it['platform']}|{it['platform_post_id']}"] = it  # nilai asli (null tetap null)
                last_cursor = res.next_cursor
                has_more = bool(res.has_more and res.next_cursor)
                if not has_more:
                    break
                cursor = res.next_cursor
        if dropped:
            d.logger.warning("item tidak valid dibuang", extra={"dropped": dropped, "connector": msg.connector_key})
    except BaseException as e:  # noqa: BLE001 — semua kegagalan dilaporkan sebagai hasil, bukan crash worker
        if isinstance(e, (KeyboardInterrupt, SystemExit)):
            raise
        error = to_connector_error(e)
    finally:
        if lock_owner and d.session_lock:
            await d.session_lock.release(account_id, lock_owner)

    lst = list(items.values())
    items_ref = (
        await d.blobs.put_jsonl(f"batches/{msg.crawl_run_id}/{msg.attempt_no}{f'-{part}' if part else ''}.jsonl.gz", lst) if lst else None
    )
    rl = rate
    out = {
        "crawl_run_id": str(msg.crawl_run_id),
        "attempt_no": msg.attempt_no,
        "connector_id": str(msg.connector_id),
        "provider_account_id": account_id,
        "reservation_id": msg.reservation_id,
        "outcome": "error" if error else "success",
        "error": (
            {
                "code": error.code,
                "message": redact(error.message, secrets_seen)[:500],
                "retry_after_ms": error.retry_after_ms,
                "scope": error.scope,
                "http_status": error.http_status,
            }
            if error
            else None
        ),
        "items_ref": items_ref,
        "items_count": len(lst),
        "next_cursor": last_cursor,
        "has_more": has_more,
        "async_handle": None,
        "usage": usage,
        "duration_ms": max(0, round((d.now() - t0) * 1000)),
        "rate_limit_info": {"remaining": rl.remaining if rl else None, "resetAt": rl.reset_at if rl else None},
        "part": part,
        "resume_state": None,
    }
    FetchResultPayload.model_validate(out)
    return out

