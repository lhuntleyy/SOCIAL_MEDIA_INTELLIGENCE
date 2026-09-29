"""I-16 execute_fetch: halaman × sub-query, maxItems, item tak valid dibuang, error di tengah → item tetap diteruskan,
secret tidak bocor di error, session lock (akun sesi hanya 1 worker), resume tidak didukung, hasil = kontrak fetch.result."""
import asyncio
from datetime import datetime, timedelta, timezone

from smip_contracts import FetchResultPayload

from smip_fetch.accounts import AccountMaterial
from smip_fetch.blobs import MemoryBlobStore
from smip_fetch.connector import Credential
from smip_fetch.contract import CapturingLogger
from smip_fetch.errors import ConnectorError
from smip_fetch.execute import FetchDeps, SessionLock, execute_fetch, fetch_result_key, uuid7
from smip_fetch.fake import FakeConnector, FakeStep, fake_item

SECRET = "sessionid-RAHASIA-zz99887766"
ACC = "0192f000-0000-7000-8000-000000000013"


class FakeRedis:
    def __init__(self):
        self.kv = {}

    async def set(self, k, v, nx=False, px=None):
        if nx and k in self.kv:
            return None
        self.kv[k] = v
        return True

    async def eval(self, script, n, key, owner):
        if self.kv.get(key) == owner:
            del self.kv[key]
            return 1
        return 0


def msg(key="fake.x.py", **req):
    deadline = (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    r = {
        "requestId": uuid7(),
        "idempotencyKey": "run.r1.attempt.1",
        "platform": "x",
        "operation": "search_keyword",
        "queries": [{"native": "kopdes", "sourceNodeIds": []}, {"native": "koperasi", "sourceNodeIds": []}],
        "window": {"since": "2026-09-27T00:00:00.000Z"},
        "cursor": None,
        "pageLimit": 2,
        "maxItems": 5,
    }
    r.update(req)
    return {
        "crawl_run_id": "0192f000-0000-7000-8000-0000000000a1",
        "attempt_no": 1,
        "connector_id": "0192f000-0000-7000-8000-000000000011",
        "connector_key": key,
        "connector_version": "0.1.0",
        "provider_account_id": ACC,
        "reservation_id": "res-1",
        "request": r,
        "deadline_at": deadline,
    }


def deps(conn, redis=None):
    async def accounts(account_id, connector_id):
        return AccountMaterial(Credential("session", {"sessionid": SECRET}), {})

    return FetchDeps(
        connectors={conn.manifest.key: conn},
        accounts=accounts,
        blobs=MemoryBlobStore(),
        logger=CapturingLogger(),
        session_lock=SessionLock(redis) if redis else None,
    )


async def test_pages_queries_and_max_items():
    f = FakeConnector(platform="x").script(
        [
            FakeStep(respond={"items": [fake_item("x", 1), fake_item("x", 2)], "next_cursor": "c2"}),
            FakeStep(respond={"items": [fake_item("x", 2), fake_item("x", 3), {"bad": True}], "returned": 4}),
            FakeStep(respond={"items": [fake_item("x", 4), fake_item("x", 5), fake_item("x", 6)]}),
        ]
    )
    d = deps(f)
    out = await execute_fetch(d, msg())
    FetchResultPayload.model_validate(out)
    assert out["outcome"] == "success"
    assert out["items_count"] == 5  # unik + dibatasi maxItems
    assert [c.cursor for c in f.calls] == [None, "c2", None]
    assert [c.query.native for c in f.calls] == ["kopdes", "kopdes", "koperasi"]
    assert out["usage"]["requests"] == 3 and out["usage"]["results"] == 2 + 4 + 3
    rows = await d.blobs.get_jsonl(out["items_ref"])
    assert len(rows) == 5 and rows[0]["author"]["followers"] is None  # null tetap null


async def test_error_midway_keeps_items_and_redacts_secret():
    f = FakeConnector(platform="x").script(
        [
            FakeStep(respond={"items": [fake_item("x", 1)], "next_cursor": "c2"}),
            FakeStep(fail={"code": "CHALLENGE_REQUIRED"}),
        ]
    )

    async def boom(req, ctx):
        raise ConnectorError("CHALLENGE_REQUIRED", f"checkpoint untuk sessionid={SECRET}")

    d = deps(f)
    out = await execute_fetch(d, msg())
    assert out["outcome"] == "error" and out["error"]["code"] == "CHALLENGE_REQUIRED" and out["error"]["scope"] == "account"
    assert out["items_count"] == 1  # sudah dibayar → tetap diteruskan
    f.script([FakeStep(respond={"items": []})])
    f.fetch = boom  # type: ignore[method-assign]
    out2 = await execute_fetch(d, msg())
    assert SECRET not in str(out2) and "[REDACTED]" in out2["error"]["message"]


async def test_session_lock_exclusive():
    redis = FakeRedis()
    slow = FakeConnector(platform="x", exclusive_session=True).script([FakeStep(delay_s=0.3, respond={"items": [fake_item("x", 1)]})])
    d = deps(slow, redis)
    a, b = await asyncio.gather(execute_fetch(d, msg(pageLimit=1, queries=[{"native": "a", "sourceNodeIds": []}])),
                                execute_fetch(d, msg(pageLimit=1, queries=[{"native": "b", "sourceNodeIds": []}])))
    outcomes = sorted([a["outcome"], b["outcome"]])
    assert outcomes == ["error", "success"]
    err = a if a["outcome"] == "error" else b
    assert err["error"]["code"] == "RATE_LIMITED" and err["error"]["retry_after_ms"] == 5000
    assert redis.kv == {}  # lock dilepas


async def test_unknown_connector_resume_and_expired_deadline():
    f = FakeConnector(platform="x")
    d = deps(f)
    assert (await execute_fetch(d, msg(key="tidak.ada")))["error"]["code"] == "NOT_SUPPORTED"
    m = msg()
    m["resume"] = {"async_handle": {"kind": "k", "id": "1", "startedAt": "2026-09-29T00:00:00.000Z", "pollAfterMs": 1000}, "query_index": 0, "page": 1, "seq": 1}
    r = await execute_fetch(d, m)
    assert r["error"]["code"] == "NOT_SUPPORTED" and r["part"] == 1
    m = msg()
    m["deadline_at"] = "2020-01-01T00:00:00.000Z"
    assert (await execute_fetch(d, m))["error"]["code"] == "TIMEOUT"


def test_result_key_matches_ts():
    assert fetch_result_key("r1", 2, 0) == "run.r1.attempt.2.result"
    assert fetch_result_key("r1", 2, 3) == "run.r1.attempt.2.result.3"
