"""`python -m smip_fetch.manifests` → JSON manifest connector Python (dibaca `bun scripts/connectors.ts register`).
Bentuk field = ConnectorManifest TS (camelCase) agar registrasi memakai jalur yang sama. Connector `fake` dilewati."""
from __future__ import annotations

import json
import sys

from .registry import connector_registry


def manifests() -> list[dict]:
    out = []
    for c in connector_registry("production").values():
        m = c.manifest
        out.append(
            {
                "key": m.key,
                "version": m.version,
                "providerKey": m.provider_key,
                "providerKind": m.provider_kind,
                "platform": m.platform,
                "runtime": "python",
                "displayName": m.display_name,
                "credentialKinds": m.credential_kinds,
                "configSchema": m.config_schema,
                "operations": {
                    op: {
                        "queryFeatures": s.query_features,
                        "maxQueryLength": s.max_query_length,
                        "supportsSince": s.supports_since,
                        "supportsUntil": s.supports_until,
                        "supportsCursor": s.supports_cursor,
                        "maxPageSize": s.max_page_size,
                        "returnsFields": s.returns_fields,
                        "asyncExecution": s.async_execution,
                        "resultOrder": s.result_order,
                    }
                    for op, s in m.operations.items()
                },
                "costModel": {"unit": m.cost_unit, "reportsUsageInResponse": False},
                "docsUrl": m.docs_url,
                "allowedHosts": m.allowed_hosts,
            }
        )
    return out


if __name__ == "__main__":
    json.dump(manifests(), sys.stdout)
