"""Service `worker-fetch-py` (ARCHITECTURE §5): consume `fetch.py` → execute_fetch → enqueue `fetch.result` (BullMQ, interop S-04).

Env: DATABASE_URL, REDIS_URL (queue), REDIS_CACHE_URL (session lock, rl), S3_*, KMS_*, NODE_ENV, WORKER_FETCH_PY_CONCURRENCY.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from typing import Any

from bullmq import Queue, Worker

from .accounts import db_account_loader
from .blobs import S3BlobStore
from .crypto import create_kms
from .execute import FetchDeps, SessionLock, dynamic_limit_setter, envelope, execute_fetch, fetch_result_key
from .registry import connector_registry

# kebijakan queue fetch.result = QUEUE_POLICIES TS (attempts 5, exponential 1 s)
RESULT_OPTS = {
    "attempts": 5,
    "backoff": {"type": "exponential", "delay": 1000},
    "removeOnComplete": {"age": 24 * 3600, "count": 10_000},
    "removeOnFail": {"age": 7 * 24 * 3600},
}


class JsonLogger(logging.LoggerAdapter):
    def process(self, msg: str, kwargs: Any) -> tuple[str, Any]:
        extra = kwargs.pop("extra", {}) or {}
        return json.dumps({"service": "worker-fetch-py", "msg": msg, **extra}), kwargs


async def handle_job(deps: FetchDeps, results: Queue, env: dict[str, Any]) -> dict[str, Any]:
    out = await execute_fetch(deps, env["payload"])
    key = fetch_result_key(out["crawl_run_id"], out["attempt_no"], out["part"])
    msg = envelope("fetch.result", key, env.get("tenant_id"), out)
    await results.add("fetch.result", msg, {"jobId": key, **RESULT_OPTS})
    return {"outcome": out["outcome"], "items": out["items_count"]}


async def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(message)s")
    log = JsonLogger(logging.getLogger("worker-fetch-py"), {})
    from redis.asyncio import Redis

    cache = Redis.from_url(os.environ["REDIS_CACHE_URL"])
    conn = {"connection": os.environ["REDIS_URL"]}
    deps = FetchDeps(
        connectors=connector_registry(os.environ.get("NODE_ENV", "development")),
        accounts=db_account_loader(os.environ["DATABASE_URL"], create_kms()),
        blobs=S3BlobStore(
            os.environ["S3_ENDPOINT"],
            os.environ["S3_BUCKET_RAW"],
            os.environ["S3_ACCESS_KEY_ID"],
            os.environ["S3_SECRET_ACCESS_KEY"],
            os.environ.get("S3_REGION", "us-east-1"),
        ),
        logger=log,
        session_lock=SessionLock(cache),
        on_rate_limit=dynamic_limit_setter(cache),
    )
    results = Queue("fetch.result", conn)
    worker = Worker(
        "fetch.py",
        lambda job, token: handle_job(deps, results, job.data),
        {**conn, "concurrency": int(os.environ.get("WORKER_FETCH_PY_CONCURRENCY", "4"))},
    )
    log.info("worker-fetch-py mulai", extra={"connectors": sorted(deps.connectors)})
    stop = asyncio.Event()
    for s in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(s, stop.set)
    await stop.wait()
    await worker.close()
    await results.close()
    await cache.aclose()


if __name__ == "__main__":
    asyncio.run(main())
