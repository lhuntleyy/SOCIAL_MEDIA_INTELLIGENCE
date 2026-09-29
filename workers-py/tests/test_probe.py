"""health.probe runtime python (diteruskan dari worker Bun): hasil per akun → audit; connector tak dikenal → unsupported."""
from smip_fetch.accounts import AccountMaterial
from smip_fetch.blobs import MemoryBlobStore
from smip_fetch.connector import Credential
from smip_fetch.contract import CapturingLogger
from smip_fetch.execute import FetchDeps
from smip_fetch.fake import FakeConnector
from smip_fetch.worker import handle_job


async def test_probe_via_handle_job():
    fake = FakeConnector(platform="x")
    audits = []

    async def accounts(a, c):
        return AccountMaterial(Credential("api_key", {"api_key": "x"}), {})

    async def targets(cid):
        return ("fake.x.py", ["a1", "a2"]) if cid == "c1" else ("unknown.x", ["a1"])

    async def audit(action, target, after):
        audits.append((action, target, after))

    deps = FetchDeps({fake.manifest.key: fake}, accounts, MemoryBlobStore(), CapturingLogger())
    env = {"type": "health.probe", "payload": {"connector_id": "c1", "requested_by": None, "job_id": "j1"}}
    r = await handle_job(deps, None, env, (targets, audit))
    assert r["status"] == "done" and [x["ok"] for x in r["results"]] == [True, True]
    fake.healthy = False
    r = await handle_job(deps, None, env, (targets, audit))
    assert r["results"][0] == {"account_id": "a1", "ok": False, "latency_ms": 1, "error_code": "UPSTREAM_5XX"}
    env2 = {"type": "health.probe", "payload": {"connector_id": "c2", "job_id": "j2"}}
    assert (await handle_job(deps, None, env2, (targets, audit)))["status"] == "unsupported"
    assert [a[0] for a in audits] == ["connector.health_check.result"] * 3 and audits[0][2]["runtime"] == "python"
