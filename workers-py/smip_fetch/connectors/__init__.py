"""Connector Python nyata. Unofficial (I-19) = standby: provider `risk_level=high`, default disabled, weight 0 (PROVIDER_MATRIX §3)."""
from __future__ import annotations

from ..connector import BaseConnector


def unofficial_connectors() -> list[BaseConnector]:
    from .instagrapi_instagram import InstagrapiInstagram

    return [InstagrapiInstagram()]
