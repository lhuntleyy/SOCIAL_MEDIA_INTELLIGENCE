"""Contract suite connector Python (CONNECTOR_SPEC §9) — cermin packages/connector-sdk/src/contract.ts. Dipakai pytest.

    for s in harness.scenarios: run_scenario(harness, s)
    check_manifest(harness.connector); check_deadline(harness); check_no_secret_leak(harness)
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from pydantic import ValidationError
from smip_contracts import CanonicalItem

from .connector import BaseConnector, ConnectorContext, Credential, FetchRequest, RateLimitInfo
from .errors import ConnectorError

_KEY = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(\.[a-z0-9_]+)?$")
_FORBIDDEN = re.compile(r"(price|cost|usd|rate|limit|quota|per_(minute|hour|day|month)|rpm|rps)", re.I)


@dataclass
class Scenario:
    name: str
    request: FetchRequest
    expect: str  # "ok" | kode ConnectorError
    setup: Callable[[], Any] | None = None


class CapturingLogger:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def _log(self, msg: str, *a: Any, **kv: Any) -> None:
        self.lines.append(f"{msg} {a} {kv}")

    debug = info = warning = error = _log


@dataclass
class Harness:
    connector: BaseConnector
    credential: Credential
    config: dict[str, Any]
    scenarios: list[Scenario]
    secret_values: list[str]
    logs: list[str] = field(default_factory=list)
    rate_limits: list[RateLimitInfo] = field(default_factory=list)


def context(h: Harness, deadline_s: float = 10.0) -> tuple[ConnectorContext, CapturingLogger]:
    log = CapturingLogger()

    async def archive(page: Any, meta: dict[str, Any]) -> str:
        return "mem://raw/contract"

    ctx = ConnectorContext(
        credential=h.credential,
        config=h.config,
        logger=log,
        deadline=asyncio.get_running_loop().time() + deadline_s,
        report_rate_limit=h.rate_limits.append,
        archive_raw=archive,
    )
    return ctx, log


def _numbers(o: Any, path: str = "") -> list[str]:
    if isinstance(o, dict):
        return [p for k, v in o.items() for p in (_numbers(v, f"{path}.{k}") if not isinstance(v, (int, float)) or isinstance(v, bool) else ([f"{path}.{k}"] if _FORBIDDEN.search(k) else []))]
    if isinstance(o, list):
        return [p for i, v in enumerate(o) for p in _numbers(v, f"{path}[{i}]")]
    return []


def check_manifest(c: BaseConnector) -> None:
    m = c.manifest
    assert _KEY.match(m.key), m.key
    parts = m.key.split(".")
    assert parts[0] == m.provider_key and parts[1] == m.platform
    assert re.match(r"^\d+\.\d+\.\d+", m.version)
    assert m.docs_url.startswith("https://")
    assert m.operations, "minimal satu operation"
    assert m.runtime == "python"
    assert _numbers(m.config_schema) == [], "angka harga/rate dilarang di manifest (Golden Rule 1)"
    if m.provider_kind == "unofficial":
        assert m.exclusive_session or "session" not in m.credential_kinds, "connector sesi unofficial wajib exclusive_session"


async def run_scenario(h: Harness, s: Scenario) -> None:
    if s.setup:
        s.setup()
    ctx, log = context(h)
    m = h.connector.manifest
    if s.expect == "ok":
        r = await h.connector.fetch(s.request, ctx)
        op = m.operations[s.request.operation]
        for it in r.items:
            try:
                CanonicalItem.model_validate(it)
            except ValidationError as e:  # pragma: no cover - pesan assert
                raise AssertionError(f"item tidak valid: {e.errors()[:3]}") from None
            assert it["platform"] == m.platform
            assert it["provenance"]["connector_key"] == m.key
            if op.supports_since and s.request.since:
                assert it["published_at"] >= s.request.since
        assert len(r.items) <= s.request.max_items
        assert r.usage.requests >= 1
        assert r.usage.results >= len(r.items)  # biaya dari yang DIKEMBALIKAN (P-15)
        if r.has_more:
            assert r.next_cursor
    else:
        try:
            await h.connector.fetch(s.request, ctx)
        except ConnectorError as e:
            assert e.code == s.expect, f"{s.name}: {e.code} != {s.expect}"
            if s.expect == "RATE_LIMITED":
                assert h.rate_limits or e.retry_after_ms, "RATE_LIMITED wajib melaporkan info rate limit"
        except Exception as e:  # noqa: BLE001
            raise AssertionError(f"{s.name}: error mentah {type(e).__name__} (wajib ConnectorError)") from e
        else:
            raise AssertionError(f"{s.name}: harusnya gagal {s.expect}")
    h.logs.extend(log.lines)


async def check_deadline(h: Harness) -> None:
    ok = next(s for s in h.scenarios if s.expect == "ok")
    if ok.setup:
        ok.setup()
    ctx, _ = context(h, deadline_s=-1)
    t0 = asyncio.get_running_loop().time()
    try:
        await h.connector.fetch(ok.request, ctx)
    except ConnectorError as e:
        assert e.code == "TIMEOUT"
    else:
        raise AssertionError("deadline lewat harus TIMEOUT")
    assert asyncio.get_running_loop().time() - t0 < 2


def check_no_secret_leak(h: Harness) -> None:
    joined = "\n".join(h.logs)
    for v in h.secret_values:
        assert v not in joined, "secret bocor ke log (SEC-02)"
    assert h.secret_values[0] not in repr(h.credential)
