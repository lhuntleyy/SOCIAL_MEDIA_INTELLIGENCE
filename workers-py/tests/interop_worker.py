"""Dipanggil test Bun (apps/worker-fetch-bun/test/py-interop.test.ts): konsumsi SATU job fetch.py dari Redis nyata
dengan FakeConnector Python, laporkan ke fetch.result (format envelope/jobId TS), lalu keluar."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bullmq import Queue, Worker  # noqa: E402

from smip_fetch.accounts import AccountMaterial  # noqa: E402
from smip_fetch.blobs import MemoryBlobStore  # noqa: E402
from smip_fetch.connector import Credential  # noqa: E402
from smip_fetch.contract import CapturingLogger  # noqa: E402
from smip_fetch.execute import FetchDeps  # noqa: E402
from smip_fetch.fake import FakeConnector, FakeStep, fake_item  # noqa: E402
from smip_fetch.worker import handle_job  # noqa: E402


async def main() -> None:
    url, prefix = sys.argv[1], sys.argv[2]
    conn = {"connection": url, "prefix": prefix}
    fake = FakeConnector(platform="x").script([FakeStep(respond={"items": [fake_item("x", 1), fake_item("x", 2)]})])

    async def accounts(a, c):
        return AccountMaterial(Credential("api_key", {"api_key": "x"}), {})

    deps = FetchDeps({fake.manifest.key: fake}, accounts, MemoryBlobStore(), CapturingLogger())
    results = Queue("fetch.result", conn)
    done = asyncio.Event()

    async def process(job, token):
        r = await handle_job(deps, results, job.data)
        done.set()
        return r

    worker = Worker("fetch.py", process, conn)
    await asyncio.wait_for(done.wait(), 20)
    await asyncio.sleep(0.3)
    await worker.close()
    await results.close()


asyncio.run(main())
