"""S-04: interop BullMQ Python <-> TypeScript pada queue yang sama.

  python bullmq_interop.py consume <queue>   -> proses 1 job, cetak data job (JSON)
  python bullmq_interop.py produce <queue>   -> tambah 1 job, cetak id (JSON)
"""
import asyncio
import json
import sys

from bullmq import Queue, Worker

REDIS = {"connection": "redis://127.0.0.1:6390"}


async def consume(qname: str) -> None:
    done = asyncio.Event()
    seen: dict = {}

    async def process(job, token):
        seen["data"] = job.data
        seen["name"] = job.name
        seen["id"] = job.id
        done.set()
        return {"echo": job.data, "by": "python"}

    worker = Worker(qname, process, REDIS)
    await asyncio.wait_for(done.wait(), 20)
    await asyncio.sleep(0.5)  # beri waktu worker menulis status completed
    await worker.close()
    print(json.dumps(seen))


async def produce(qname: str) -> None:
    q = Queue(qname, REDIS)
    job = await q.add("py2ts", {"from": "python", "n": 42}, {"jobId": "py-1", "attempts": 2})
    await q.close()
    print(json.dumps({"id": job.id}))


if __name__ == "__main__":
    mode, qname = sys.argv[1], sys.argv[2]
    asyncio.run(consume(qname) if mode == "consume" else produce(qname))
