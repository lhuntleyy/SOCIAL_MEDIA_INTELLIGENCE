"""I-16 DoD: fake connector Python lulus contract suite."""
import pytest

from smip_fetch.connector import Credential, FetchRequest, Query
from smip_fetch.contract import Harness, Scenario, check_deadline, check_manifest, check_no_secret_leak, run_scenario
from smip_fetch.fake import FakeConnector, FakeStep, fake_item

SECRET = "sessionid-RAHASIA-abcdef123456"


def req(**over):
    base = dict(
        request_id="0192f000-0000-7000-8000-000000000001",
        idempotency_key="run.x.attempt.1.q0.page.1",
        platform="x",
        operation="search_keyword",
        page_limit=1,
        max_items=10,
        query=Query('"koperasi merah putih" OR kopdes', []),
        since="2026-09-27T00:00:00.000Z",
    )
    base.update(over)
    return FetchRequest(**base)


fake = FakeConnector(platform="x")
H = Harness(
    connector=fake,
    credential=Credential("session", {"sessionid": SECRET}),
    config={},
    secret_values=[SECRET],
    scenarios=[
        Scenario("sukses", req(), "ok", lambda: fake.script([FakeStep(respond={"items": [fake_item("x", 1), fake_item("x", 2)], "next_cursor": "c2"})])),
        Scenario("rate limit", req(), "RATE_LIMITED", lambda: fake.script([FakeStep(fail={"code": "RATE_LIMITED", "retry_after_ms": 30000})])),
        Scenario("auth", req(), "AUTH_INVALID", lambda: fake.script([FakeStep(fail={"code": "AUTH_INVALID"})])),
        Scenario("challenge", req(), "CHALLENGE_REQUIRED", lambda: fake.script([FakeStep(fail={"code": "CHALLENGE_REQUIRED"})])),
        Scenario("op tak didukung", req(operation="profile"), "NOT_SUPPORTED"),
    ],
)


def test_manifest():
    check_manifest(fake)


@pytest.mark.parametrize("s", H.scenarios, ids=lambda s: s.name)
async def test_scenario(s):
    await run_scenario(H, s)


async def test_deadline():
    await check_deadline(H)


def test_no_secret_leak():
    check_no_secret_leak(H)
