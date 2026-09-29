"""Connector `fake` Python (TESTING §3) — cermin packages/connectors/fake, runtime python (key `fake.<platform>.py`)."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .connector import BaseConnector, ConnectorContext, FetchRequest, FetchResult, HealthProbeResult, Manifest, OperationSupport, Usage
from .errors import ConnectorError

OP = OperationSupport(
    query_features=["term", "phrase", "or", "and", "not", "group"],
    max_query_length=512,
    supports_since=True,
    supports_until=True,
    supports_cursor=True,
    max_page_size=100,
    returns_fields=["metrics.likes"],
    result_order="desc",
)


def fake_item(platform: str, n: int, **over: Any) -> dict[str, Any]:
    at = (datetime(2026, 9, 27, 10, 0, tzinfo=timezone.utc) + timedelta(minutes=n)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    it: dict[str, Any] = {
        "schema": "canonical-item/v1",
        "platform": platform,
        "platform_post_id": str(1830000000000000000 + n),
        "content_type": "post",
        "url": f"https://example.invalid/{platform}/{n}",
        "text": f"post fake {n} tentang kopdes",
        "lang_hint": None,
        "published_at": at,
        "parent": None,
        "root_post_id": None,
        "author": {
            "platform_user_id": f"u{n % 7}",
            "handle": f"akun{n % 7}",
            "display_name": None,
            "followers": None,
            "following": None,
            "verified": None,
            "created_at": None,
            "location_raw": None,
            "avatar_url": None,
        },
        "metrics": {"likes": n, "comments": None, "shares": None, "views": None, "quotes": None, "saves": None, "captured_at": at},
        "hashtags": [],
        "mentions": [],
        "media": [],
        "geo": {"lat": None, "lng": None, "place_name": None},
        "is_ad": None,
        "extra": {},
        "provenance": {"connector_key": f"fake.{platform}.py", "connector_version": "0.1.0", "fetched_at": at, "raw_ref": None},
    }
    it.update(over)
    return it


@dataclass
class FakeStep:
    respond: dict[str, Any] | None = None  # {"items": [...], "next_cursor": str|None, "returned": int}
    fail: dict[str, Any] | None = None  # {"code": ..., "retry_after_ms": ..., "http_status": ...}
    delay_s: float = 0.0
    op: str | None = None


@dataclass
class FakeConnector(BaseConnector):
    platform: str
    exclusive_session: bool = False
    steps: list[FakeStep] = field(default_factory=list)
    calls: list[FetchRequest] = field(default_factory=list)
    healthy: bool = True

    def __post_init__(self) -> None:
        self.manifest = Manifest(
            key=f"fake.{self.platform}.py",
            version="0.1.0",
            provider_key="fake",
            platform=self.platform,
            display_name=f"Fake {self.platform} (python)",
            credential_kinds=["api_key", "session", "none"],
            config_schema={"type": "object", "additionalProperties": False, "properties": {}},
            operations={"search_keyword": OP, "post_detail": OperationSupport(**{**OP.__dict__, "query_features": []})},
            cost_unit="request",
            docs_url="https://example.invalid/fake",
            exclusive_session=self.exclusive_session,
        )

    def script(self, steps: list[FakeStep]) -> "FakeConnector":
        self.steps = list(steps)
        self.calls.clear()
        return self

    async def fetch(self, req: FetchRequest, ctx: ConnectorContext) -> FetchResult:
        if ctx.expired():
            raise ConnectorError("TIMEOUT", "deadline sudah lewat")
        if req.operation not in self.manifest.operations:
            raise ConnectorError("NOT_SUPPORTED", f"operation {req.operation} tidak didukung")
        self.calls.append(req)
        step = self.steps.pop(0) if self.steps else FakeStep(respond={"items": []})
        if step.delay_s:
            try:
                await asyncio.wait_for(asyncio.sleep(step.delay_s), timeout=max(0.001, ctx.remaining()))
            except asyncio.TimeoutError:
                raise ConnectorError("TIMEOUT", f"deadline terlampaui (delay {step.delay_s}s)") from None
        if step.fail:
            raise ConnectorError(
                step.fail["code"],
                f"fake: {step.fail['code']}",
                retry_after_ms=step.fail.get("retry_after_ms"),
                http_status=step.fail.get("http_status"),
            )
        resp = step.respond or {"items": []}
        items = [i for i in resp["items"] if not req.since or not isinstance(i, dict) or i.get("published_at", "") >= req.since][: req.max_items]
        return FetchResult(
            items=items,
            next_cursor=resp.get("next_cursor"),
            has_more=bool(resp.get("next_cursor")),
            usage=Usage(requests=1, results=resp.get("returned", len(resp["items"]))),
        )

    async def health_probe(self, ctx: ConnectorContext) -> HealthProbeResult:
        return HealthProbeResult(ok=self.healthy, latency_ms=1, error_code=None if self.healthy else "UPSTREAM_5XX")
