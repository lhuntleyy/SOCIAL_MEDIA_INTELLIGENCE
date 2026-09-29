"""Blob store JSONL gzip — format identik packages/storage (ref `s3://bucket/key` / `mem://key`)."""
from __future__ import annotations

import gzip
import json
import re
from typing import Any, Protocol

_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$")


def _safe_key(key: str) -> str:
    if not _SAFE.match(key) or ".." in key:
        raise ValueError(f"key blob tidak aman: {key}")
    return key


def encode(rows: list[Any]) -> bytes:
    body = "\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows) + ("\n" if rows else "")
    return gzip.compress(body.encode())


def decode(buf: bytes) -> list[Any]:
    return [json.loads(line) for line in gzip.decompress(buf).decode().split("\n") if line]


class BlobStore(Protocol):
    async def put_jsonl(self, key: str, rows: list[Any]) -> str: ...
    async def get_jsonl(self, ref: str) -> list[Any]: ...


class MemoryBlobStore:
    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}

    async def put_jsonl(self, key: str, rows: list[Any]) -> str:
        self.blobs[_safe_key(key)] = encode(rows)
        return f"mem://{key}"

    async def get_jsonl(self, ref: str) -> list[Any]:
        return decode(self.blobs[ref.removeprefix("mem://")])


class S3BlobStore:
    def __init__(self, endpoint: str, bucket: str, access_key: str, secret_key: str, region: str = "us-east-1") -> None:
        import boto3  # dependensi hanya bila S3 dipakai

        self._bucket = bucket
        self._s3 = boto3.client(
            "s3", endpoint_url=endpoint, aws_access_key_id=access_key, aws_secret_access_key=secret_key, region_name=region
        )

    async def put_jsonl(self, key: str, rows: list[Any]) -> str:
        import asyncio

        body = encode(rows)
        await asyncio.to_thread(self._s3.put_object, Bucket=self._bucket, Key=_safe_key(key), Body=body, ContentType="application/gzip")
        return f"s3://{self._bucket}/{key}"

    async def get_jsonl(self, ref: str) -> list[Any]:
        import asyncio

        prefix = f"s3://{self._bucket}/"
        if not ref.startswith(prefix):
            raise ValueError(f"ref bukan milik bucket {self._bucket}")
        obj = await asyncio.to_thread(self._s3.get_object, Bucket=self._bucket, Key=_safe_key(ref[len(prefix):]))
        return decode(obj["Body"].read())
