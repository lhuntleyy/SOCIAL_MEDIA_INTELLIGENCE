"""Registry connector runtime python. Aktif/tidaknya diatur DB (providers/connectors.enabled + routing), bukan di sini."""
from __future__ import annotations

from .connector import BaseConnector
from .fake import FakeConnector

FAKE_PLATFORMS = ["x", "instagram", "facebook", "threads", "tiktok", "youtube"]


def connector_registry(env: str) -> dict[str, BaseConnector]:
    conns: list[BaseConnector] = []
    # connector unofficial (I-19) didaftarkan di sini; default disabled + weight 0 di DB (standby)
    try:
        from .connectors import unofficial_connectors  # noqa: PLC0415

        conns.extend(unofficial_connectors())
    except ImportError:
        pass
    if env != "production":
        conns.extend(FakeConnector(platform=p) for p in FAKE_PLATFORMS)
    return {c.manifest.key: c for c in conns}
