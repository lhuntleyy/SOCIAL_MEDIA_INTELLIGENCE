"""Redaksi secret di teks bebas (cermin packages/observability/src/redact.ts, subset) — SEC-02."""
from __future__ import annotations

import re

REDACTED = "[REDACTED]"
_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1 " + REDACTED),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}"), REDACTED),
    (re.compile(r"\b(sk-ant-[A-Za-z0-9_-]{8,}|apify_api_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})"), REDACTED),
    (re.compile(r"(://[^:/?#\s@]+):([^@/\s]+)@"), r"\1:" + REDACTED + "@"),
    (
        re.compile(r"([?&](?:token|access_token|api_key|apikey|key|sig|signature|password|sessionid)=)[^&\s#\"']+", re.I),
        r"\1" + REDACTED,
    ),
    (
        re.compile(
            r"\b((?:access_|refresh_|id_)?token|api[_-]?key|x-api-key|password|passwd|secret|client_secret|sessionid|session_id|cookie)"
            r"(\"?\s*[=:]\s*)([\"']?)(?!\[REDACTED\])[^\s&,;\"'}]+([\"']?)",
            re.I,
        ),
        r"\1\2\3" + REDACTED + r"\4",
    ),
]


def redact(s: str, secrets: list[str] | None = None) -> str:
    out = s
    for v in secrets or []:
        if v and len(v) >= 4:
            out = out.replace(v, REDACTED)
    for rx, rep in _PATTERNS:
        out = rx.sub(rep, out)
    return out
