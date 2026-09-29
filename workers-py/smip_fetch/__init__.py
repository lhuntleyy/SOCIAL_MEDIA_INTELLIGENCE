"""I-16 worker-fetch-py: runtime Python untuk connector yang butuh library Python (CONNECTOR_SPEC §3, ADR-003).

Cermin worker-fetch-bun: satu job `fetch.py` = satu ATTEMPT pada satu connector; hasil → `fetch.result` (kontrak sama).
"""
