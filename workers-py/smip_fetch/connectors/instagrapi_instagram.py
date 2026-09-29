"""Instagram via instagrapi (private API, UNOFFICIAL) — I-19, standby prioritas terakhir (PROVIDER_MATRIX §2/§3).

Kontrol keamanan (docs/security/I-19-instagrapi-review.md):
  * HANYA sesi yang sudah ada (credential kind `session`: `settings` JSON dump instagrapi atau `sessionid`) — TIDAK ada
    login username/password otomatis (login berulang = pola bot → challenge/ban). Challenge → CHALLENGE_REQUIRED
    (akun → needs_attention, ditangani manual; CONNECTOR_SPEC §7), tidak pernah di-resolve otomatis.
  * Satu akun = satu worker (`exclusive_session` → session lock Redis, I-16).
  * Egress allowlist di level sesi HTTP library: host selain Instagram ditolak (SECURITY §6) — termasuk redirect/CDN.
  * Minimisasi data: hanya field CanonicalItem; tidak mengambil daftar follower/following, DM, atau profil privat.
  * Tidak ada angka rate/harga di kode; jeda antar request (`delay_range`) dari config operator.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import timezone
from typing import Any, Callable
from urllib.parse import urlparse

from ..connector import (
    BaseConnector,
    ConnectorContext,
    FetchRequest,
    FetchResult,
    HealthProbeResult,
    Manifest,
    OperationSupport,
    RateLimitInfo,
    Usage,
)
from ..errors import ConnectorError

KEY = "instagrapi.instagram"
VERSION = "0.1.0"
IG_HOSTS = ["i.instagram.com", "b.i.instagram.com", "www.instagram.com", "instagram.com"]
HASHTAG = re.compile(r"#([\w]{2,100})", re.UNICODE)
#: Jeda konservatif sebelum retry setelah throttle IG (bukan angka provider — kebijakan keamanan akun internal).
THROTTLE_BACKOFF_MS = 15 * 60 * 1000

CONFIG_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        # proxy residensial khusus akun (opsional) — divalidasi SSRF guard Admin API (I-21)
        "proxy": {"type": "string", "pattern": "^(http|https|socks5)://"},
        "delay_range": {"type": "array", "items": {"type": "number", "minimum": 0}},
        "locale": {"type": "string", "pattern": "^[a-z]{2}_[A-Z]{2}$"},
        "timezone_offset": {"type": "integer"},
    },
}

_OP = dict(
    max_query_length=None,
    supports_since=True,
    supports_until=False,
    supports_cursor=True,
    max_page_size=50,
    returns_fields=["metrics.likes", "metrics.comments"],
    async_execution=False,
    result_order="desc",
)


def guard_session(session: Any, allowed: list[str]) -> None:
    """Bungkus `session.request` (requests.Session) → host di luar allowlist ditolak sebelum koneksi dibuka."""
    if getattr(session, "_smip_guarded", False):
        return
    orig = session.request

    def request(method: str, url: str, *a: Any, **kw: Any) -> Any:
        host = (urlparse(url).hostname or "").lower()
        if not any(host == h or host.endswith(f".{h}") for h in allowed):
            raise ConnectorError("FORBIDDEN", f"egress ke host {host} ditolak (allowlist connector)", scope="connector")
        kw.setdefault("allow_redirects", False)  # redirect lintas host = egress liar
        return orig(method, url, *a, **kw)

    session.request = request
    session._smip_guarded = True


def classify(e: BaseException) -> ConnectorError:
    """Exception instagrapi → taksonomi CONNECTOR_SPEC §7 (pesan TIDAK menyertakan isi respons: bisa memuat cookie)."""
    if isinstance(e, ConnectorError):
        return e
    from instagrapi import exceptions as ex

    name = type(e).__name__
    if isinstance(e, (ex.ChallengeRequired, ex.CaptchaChallengeRequired, ex.TwoFactorRequired, ex.FeedbackRequired, ex.ChallengeError)):
        return ConnectorError("CHALLENGE_REQUIRED", f"instagram meminta verifikasi akun ({name}) — tangani manual", scope="account")
    if isinstance(e, (ex.LoginRequired, ex.ClientLoginRequired, ex.ClientUnauthorizedError)):
        return ConnectorError("AUTH_INVALID", f"sesi instagram tidak valid/kedaluwarsa ({name})", scope="account")
    if isinstance(e, (ex.SentryBlock, ex.ProxyAddressIsBlocked)):
        return ConnectorError("BLOCKED", f"akun/IP diblokir instagram ({name})", scope="account")
    if isinstance(e, (ex.RateLimitError, ex.ClientThrottledError, ex.PleaseWaitFewMinutes)):
        return ConnectorError("RATE_LIMITED", f"instagram membatasi akun ({name})", scope="account", retry_after_ms=THROTTLE_BACKOFF_MS)
    if isinstance(e, ex.ClientForbiddenError):
        return ConnectorError("FORBIDDEN", f"instagram menolak akses ({name})", scope="account")
    if isinstance(e, (ex.ClientBadRequestError, ex.WrongCursorError)):
        return ConnectorError("INVALID_QUERY", f"permintaan ditolak instagram ({name})", scope="request")
    if isinstance(e, ex.ClientJSONDecodeError):
        return ConnectorError("PARSE_ERROR", "respons instagram tidak dapat diparse")
    if isinstance(e, (ex.ClientConnectionError, ConnectionError)):
        return ConnectorError("NETWORK", f"koneksi ke instagram gagal ({name})")
    if isinstance(e, TimeoutError):
        return ConnectorError("TIMEOUT", "timeout instagram")
    return ConnectorError("UNKNOWN", f"instagrapi: {name}")


def _iso(dt: Any) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:  # zona tak diketahui → tolak (CONNECTOR_SPEC §4), jangan menebak
        return None
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def normalize(m: Any, fetched_at: str, raw_ref: str | None) -> dict[str, Any] | None:
    code = getattr(m, "code", None)
    user = getattr(m, "user", None)
    published = _iso(getattr(m, "taken_at", None))
    pk = str(getattr(user, "pk", "") or "") if user else ""
    handle = getattr(user, "username", None) if user else None
    if not code or not published or not pk or not handle:
        return None
    caption = getattr(m, "caption_text", None) or ""
    hidden = bool(getattr(m, "like_and_view_counts_disabled", False))
    media_type = getattr(m, "media_type", None)  # 1 foto, 2 video, 8 album
    thumb = getattr(m, "thumbnail_url", None)
    thumb = str(thumb) if thumb else None
    url = f"https://www.instagram.com/p/{code}/"
    return {
        "schema": "canonical-item/v1",
        "platform": "instagram",
        "platform_post_id": code,  # shortcode — sama dengan connector Apify (dedupe lintas connector)
        "content_type": "post",
        "url": url,
        "text": caption,
        "lang_hint": None,
        "published_at": published,
        "parent": None,
        "root_post_id": None,
        "author": {
            "platform_user_id": pk,
            "handle": handle,
            "display_name": getattr(user, "full_name", None) or None,
            "followers": None,  # tidak diambil (butuh request profil per author — minimisasi)
            "following": None,
            "verified": getattr(user, "is_verified", None),
            "created_at": None,
            "location_raw": None,
            "avatar_url": None,
        },
        "metrics": {
            "likes": None if hidden else _int(getattr(m, "like_count", None)),
            "comments": _int(getattr(m, "comment_count", None)),
            "shares": None,
            "views": None if hidden else _int(getattr(m, "play_count", None) or getattr(m, "view_count", None)),
            "quotes": None,
            "saves": None,
            "captured_at": fetched_at,
        },
        "hashtags": sorted({h.lower() for h in HASHTAG.findall(caption)}),
        "mentions": [],
        "media": [{"type": "video" if media_type == 2 else "image", "url": url, "thumb": thumb}],
        "geo": {"lat": None, "lng": None, "place_name": None},
        "is_ad": None,
        "extra": {},
        "provenance": {"connector_key": KEY, "connector_version": VERSION, "fetched_at": fetched_at, "raw_ref": raw_ref},
    }


def default_client_factory() -> Any:
    from instagrapi import Client

    return Client()


class InstagrapiInstagram(BaseConnector):
    def __init__(self, client_factory: Callable[[], Any] = default_client_factory) -> None:
        self._factory = client_factory
        self.manifest = Manifest(
            key=KEY,
            version=VERSION,
            provider_key="instagrapi",
            provider_kind="unofficial",
            platform="instagram",
            display_name="Instagram via instagrapi (unofficial, standby)",
            credential_kinds=["session"],
            config_schema=CONFIG_SCHEMA,
            operations={
                "search_hashtag": OperationSupport(query_features=["term"], **_OP),
                "user_timeline": OperationSupport(query_features=[], **_OP),
                "post_detail": OperationSupport(**{**_OP, "query_features": [], "supports_since": False, "supports_cursor": False, "result_order": None}),
            },
            cost_unit="request",
            docs_url="https://subzeroid.github.io/instagrapi/",
            allowed_hosts=IG_HOSTS,
            exclusive_session=True,
        )

    # ---- sesi ----
    def _client(self, ctx: ConnectorContext, timeout_s: float) -> Any:
        """Dipanggil di thread (to_thread) — JANGAN memakai event loop di sini (timeout dihitung pemanggil)."""
        s = ctx.credential.secret
        cl = self._factory()
        cfg = ctx.config
        if cfg.get("delay_range"):
            cl.delay_range = list(cfg["delay_range"])
        if cfg.get("locale"):
            cl.set_locale(cfg["locale"])
        if cfg.get("timezone_offset") is not None:
            cl.set_timezone_offset(int(cfg["timezone_offset"]))
        if cfg.get("proxy"):
            cl.set_proxy(cfg["proxy"])
        for sess in (getattr(cl, "private", None), getattr(cl, "public", None)):
            if sess is not None:
                guard_session(sess, IG_HOSTS)
        cl.request_timeout = max(1, int(timeout_s))
        if s.get("settings"):
            try:
                cl.set_settings(json.loads(s["settings"]))  # cookie + device sesi yang sudah ada — tanpa login baru
            except (ValueError, TypeError):
                raise ConnectorError("AUTH_INVALID", "settings sesi instagram tidak valid", scope="account") from None
        elif s.get("sessionid"):
            cl.login_by_sessionid(s["sessionid"])
        else:
            raise ConnectorError("AUTH_INVALID", "credential instagrapi wajib `settings` atau `sessionid` (login password tidak didukung)", scope="account")
        return cl

    async def _call(self, ctx: ConnectorContext, fn: Callable[[], Any]) -> Any:
        if ctx.expired():
            raise ConnectorError("TIMEOUT", "deadline sudah lewat")
        try:
            return await asyncio.wait_for(asyncio.to_thread(fn), timeout=max(0.001, ctx.remaining()))
        except asyncio.TimeoutError:
            raise ConnectorError("TIMEOUT", "deadline attempt terlampaui (instagrapi)") from None
        except Exception as e:  # noqa: BLE001 — semua dipetakan ke taksonomi
            err = classify(e)
            if err.code == "RATE_LIMITED":
                ctx.report_rate_limit(RateLimitInfo(remaining=0, reset_at=None, retry_after_ms=err.retry_after_ms))
            raise err from None

    async def fetch(self, req: FetchRequest, ctx: ConnectorContext) -> FetchResult:
        if ctx.expired():
            raise ConnectorError("TIMEOUT", "deadline sudah lewat")
        if req.operation not in self.manifest.operations:
            raise ConnectorError("NOT_SUPPORTED", f"operation {req.operation} tidak didukung", scope="connector")
        amount = max(1, min(50, req.max_items))
        budget = ctx.remaining()
        cl = await self._call(ctx, lambda: self._client(ctx, budget))
        cursor: str | None = None
        if req.operation == "search_hashtag":
            tag = (req.query.native if req.query else "").strip().lstrip("#")
            if not re.fullmatch(r"[\w]{1,100}", tag, re.UNICODE):
                raise ConnectorError("INVALID_QUERY", "hashtag tidak valid", scope="request")
            medias, cursor = await self._call(
                ctx, lambda: cl.hashtag_medias_paginated_v1(tag, amount=amount, tab_key="recent", end_cursor=req.cursor)
            )
            requests = 1
        elif req.operation == "user_timeline":
            uid = (req.target_ids or [None])[0]
            if not uid or not str(uid).isdigit():
                raise ConnectorError("INVALID_QUERY", "user_timeline butuh targetIds[0] = user pk numerik", scope="request")
            medias, cursor = await self._call(ctx, lambda: cl.user_medias_paginated_v1(str(uid), amount=amount, end_cursor=req.cursor or ""))
            requests = 1
        else:  # post_detail
            codes = [c for c in (req.target_ids or []) if re.fullmatch(r"[A-Za-z0-9_-]{5,40}", c)][:amount]
            if not codes:
                raise ConnectorError("INVALID_QUERY", "post_detail butuh targetIds shortcode", scope="request")
            medias = []
            for c in codes:
                medias.append(await self._call(ctx, lambda c=c: cl.media_info_v1(cl.media_pk_from_code(c))))
            requests = len(codes)
        fetched_at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        raw_ref = await ctx.archive_raw([_raw(m) for m in medias], {"platform": "instagram", "page": 1}) if medias else None
        items: list[dict[str, Any]] = []
        for m in medias:
            it = normalize(m, fetched_at, raw_ref)
            if it is None or (req.since and it["published_at"] < req.since):
                continue
            items.append(it)
        return FetchResult(
            items=items[: req.max_items],
            next_cursor=cursor or None,
            has_more=bool(cursor) and bool(medias),
            usage=Usage(requests=requests, results=len(medias), cost_units=0.0, cost_unit_label="usd"),
            raw_refs=[raw_ref] if raw_ref else [],
        )

    async def health_probe(self, ctx: ConnectorContext) -> HealthProbeResult:
        # PASIF saja (CONNECTOR_SPEC §8.2): probe aktif ke akun unofficial menambah jejak bot; cukup validasi sesi lokal
        t0 = time.monotonic()
        try:
            budget = ctx.remaining()
            await self._call(ctx, lambda: self._client(ctx, budget))
            return HealthProbeResult(ok=True, latency_ms=int((time.monotonic() - t0) * 1000))
        except ConnectorError as e:
            return HealthProbeResult(ok=False, latency_ms=int((time.monotonic() - t0) * 1000), error_code=e.code)


def _raw(m: Any) -> Any:
    """Arsip mentah (S3) — model pydantic instagrapi → dict; objek lain apa adanya bila bisa di-serialize."""
    dump = getattr(m, "model_dump", None)
    return dump(mode="json") if dump else {k: v for k, v in vars(m).items() if isinstance(v, (str, int, float, bool, type(None)))}
