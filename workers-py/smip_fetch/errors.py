"""Taksonomi error connector (CONNECTOR_SPEC §7) — cermin packages/connector-sdk/src/errors.ts."""
from __future__ import annotations

from typing import Literal

ErrorScope = Literal["request", "account", "connector"]

DEFAULT_SCOPE: dict[str, ErrorScope] = {
    "RATE_LIMITED": "account",
    "QUOTA_EXHAUSTED": "account",
    "AUTH_INVALID": "account",
    "CHALLENGE_REQUIRED": "account",
    "FORBIDDEN": "account",
    "BLOCKED": "account",
    "NOT_SUPPORTED": "connector",
    "INVALID_QUERY": "request",
    "UPSTREAM_5XX": "connector",
    "TIMEOUT": "connector",
    "NETWORK": "connector",
    "PARSE_ERROR": "connector",
    "ASYNC_PENDING": "request",
    "UNKNOWN": "connector",
}


class ConnectorError(Exception):
    """Connector WAJIB melempar ini (bukan error mentah) — router memutuskan failover dari `code`/`scope`."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        scope: ErrorScope | None = None,
        retry_after_ms: int | None = None,
        http_status: int | None = None,
    ) -> None:
        if code not in DEFAULT_SCOPE:
            raise ValueError(f"kode error connector tidak dikenal: {code}")
        super().__init__(message)
        self.code = code
        self.message = message
        self.scope: ErrorScope = scope or DEFAULT_SCOPE[code]
        self.retry_after_ms = retry_after_ms
        self.http_status = http_status


def code_for_status(status: int) -> str:
    if status == 429:
        return "RATE_LIMITED"
    if status == 401:
        return "AUTH_INVALID"
    if status == 402:
        return "QUOTA_EXHAUSTED"
    if status == 403:
        return "FORBIDDEN"
    if status in (400, 422):
        return "INVALID_QUERY"
    if status in (404, 501):
        return "NOT_SUPPORTED"
    if status >= 500:
        return "UPSTREAM_5XX"
    return "UNKNOWN"


def to_connector_error(e: BaseException) -> ConnectorError:
    if isinstance(e, ConnectorError):
        return e
    if isinstance(e, TimeoutError):
        return ConnectorError("TIMEOUT", "timeout")
    return ConnectorError("UNKNOWN", f"{type(e).__name__}: {e}")
