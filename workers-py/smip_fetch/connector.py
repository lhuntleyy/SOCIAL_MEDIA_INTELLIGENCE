"""Kontrak connector Python (CONNECTOR_SPEC §2–§3) — cermin packages/connector-sdk/src/types.ts.

Semua logic spesifik provider HANYA di subclass BaseConnector. Angka harga/rate limit DILARANG di kode (Golden Rule 1).
"""
from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Protocol

CredentialKind = Literal["api_key", "oauth2", "session", "basic", "cookie_jar", "none"]


@dataclass
class OperationSupport:
    query_features: list[str]
    max_query_length: int | None
    supports_since: bool
    supports_until: bool
    supports_cursor: bool
    max_page_size: int | None
    returns_fields: list[str]
    async_execution: bool = False
    result_order: Literal["desc", "asc"] | None = None


@dataclass
class Manifest:
    key: str  # <provider>.<platform>[.<varian>]
    version: str
    provider_key: str
    platform: str
    display_name: str
    credential_kinds: list[CredentialKind]
    config_schema: dict[str, Any]
    operations: dict[str, OperationSupport]
    cost_unit: Literal["request", "result", "compute_unit", "credit", "unknown"]
    docs_url: str
    provider_kind: Literal["official", "third_party", "unofficial"] = "third_party"
    allowed_hosts: list[str] = field(default_factory=list)
    runtime: Literal["python"] = "python"
    #: Akun berbasis sesi login: satu sesi dipakai satu worker pada satu waktu (session lock, I-16).
    exclusive_session: bool = False


@dataclass
class Credential:
    kind: CredentialKind
    #: Hanya di memori; jangan di-log / serialize.
    secret: dict[str, str]

    def __repr__(self) -> str:  # cegah secret bocor lewat repr/log
        return f"Credential(kind={self.kind!r}, secret=<{len(self.secret)} field>)"


@dataclass
class Query:
    native: str
    source_node_ids: list[str]


@dataclass
class FetchRequest:
    request_id: str
    idempotency_key: str
    platform: str
    operation: str
    page_limit: int
    max_items: int
    query: Query | None = None
    target_ids: list[str] | None = None
    since: str | None = None
    until: str | None = None
    cursor: str | None = None


@dataclass
class Usage:
    requests: int
    #: Hasil yang DIKEMBALIKAN provider (dasar biaya, CONNECTOR_SPEC §4a).
    results: int
    cost_units: float | None = None
    cost_unit_label: str | None = None


@dataclass
class RateLimitInfo:
    remaining: int | None
    reset_at: str | None
    retry_after_ms: int | None
    scope: Literal["provider", "connector", "provider_account"] = "provider_account"


@dataclass
class FetchResult:
    items: list[dict[str, Any]]
    next_cursor: str | None
    has_more: bool
    usage: Usage
    raw_refs: list[str] = field(default_factory=list)
    warnings: list[dict[str, str]] = field(default_factory=list)


@dataclass
class HealthProbeResult:
    ok: bool
    latency_ms: int
    error_code: str | None = None


class Logger(Protocol):
    def debug(self, msg: str, **kv: Any) -> None: ...
    def info(self, msg: str, **kv: Any) -> None: ...
    def warning(self, msg: str, **kv: Any) -> None: ...
    def error(self, msg: str, **kv: Any) -> None: ...


@dataclass
class ConnectorContext:
    credential: Credential
    config: dict[str, Any]
    logger: Any
    #: Deadline attempt (asyncio loop time). Connector WAJIB menghormatinya (lihat `remaining()`).
    deadline: float
    report_rate_limit: Callable[[RateLimitInfo], None]
    archive_raw: Callable[[Any, dict[str, Any]], Awaitable[str]]

    def remaining(self) -> float:
        return self.deadline - asyncio.get_running_loop().time()

    def expired(self) -> bool:
        return self.remaining() <= 0


class BaseConnector(ABC):
    manifest: Manifest

    @abstractmethod
    async def fetch(self, req: FetchRequest, ctx: ConnectorContext) -> FetchResult:
        """Satu halaman. WAJIB melempar ConnectorError (bukan error mentah) dan menghormati deadline ctx."""

    @abstractmethod
    async def health_probe(self, ctx: ConnectorContext) -> HealthProbeResult: ...

    async def close(self) -> None:
        return None
