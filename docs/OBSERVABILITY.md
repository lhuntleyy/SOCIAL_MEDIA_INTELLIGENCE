# OBSERVABILITY

## 1. Stack
- **Logs**: JSON structured ke stdout → Loki / OpenSearch (pilih saat deploy).
- **Metrics**: Prometheus format di `/metrics` tiap service (Bun & Python) → Prometheus/VictoriaMetrics → Grafana.
- **Traces**: OpenTelemetry (OTLP) → Tempo/Jaeger. Kompat OTel JS di Bun = spike S-06; fallback: trace_id manual di log + propagasi `traceparent` di envelope.
- **Errors**: aggregator error (mis. Sentry self-hosted atau setara) — opsional.

## 2. Format Log
```json
{
  "ts": "2026-09-27T10:00:01.234Z",
  "level": "info",
  "service": "worker-fetch-bun",
  "version": "0.3.1",
  "env": "prod",
  "msg": "fetch completed",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "tenant_id": "0192…",
  "crawl_run_id": "0192…",
  "connector": "apify.instagram",
  "account_id": "0192…",
  "attempt": 1,
  "duration_ms": 18231,
  "items": 142,
  "outcome": "success"
}
```
Aturan: tidak ada teks post penuh di log level info (hanya ID); tidak ada secret (SECURITY §5); level `debug` dimatikan di prod kecuali sementara via flag.

## 3. Metrics (nama & label)

Label kardinalitas tinggi (post_id, topic_id) **dilarang** di Prometheus; gunakan ClickHouse untuk analisis per topik.

### 3.1 Ingest & Provider
| Metric | Tipe | Label |
|---|---|---|
| `smip_crawl_runs_total` | counter | platform, operation, status, run_kind |
| `smip_crawl_coalesced_total` | counter | platform |
| `smip_crawl_skipped_total` | counter | platform, reason |
| `smip_crawl_reaped_total` | counter | platform (run mandek di-reset, RUNBOOK §11) |
| `smip_crawl_gap_windows` | gauge | platform (celah partial success yang belum diambil ulang) |
| `smip_crawl_gap_abandoned_total` | counter | platform (celah melewati `max_gap_age` — data hilang yang **disadari**) |
| `smip_provider_requests_total` | counter | connector, outcome, error_code |
| `smip_provider_request_duration_seconds` | histogram | connector, operation |
| `smip_provider_items_total` | counter | connector |
| `smip_provider_cost_units_total` | counter | connector, unit_label |
| `smip_provider_empty_billed_requests_total` | counter | connector (request kosong yang tetap ditagih minimum — sinyal interval terlalu rapat) |
| `smip_router_decisions_total` | counter | platform, operation, decision (selected/none_available), reason |
| `smip_router_failovers_total` | counter | platform, from_connector, to_connector, error_code |
| `smip_provider_health_score` | gauge | connector, account_label |
| `smip_circuit_state` | gauge (0 closed,1 half,2 open) | connector, account_label |
| `smip_rate_limit_throttled_total` | counter | scope_type, connector |
| `smip_quota_used_ratio` | gauge | scope_type, scope_label, period, unit |
| `smip_data_freshness_seconds` | histogram | platform, interval_class (5m/15m/30m/45m/1h) |

### 3.2 Queue & Pipeline
| Metric | Tipe | Label |
|---|---|---|
| `smip_queue_depth` | gauge | queue, state (`waiting`,`prioritized`,`delayed`,`active`,`backlog`) — diekspor scheduler (S-05); `backlog` = sinyal KEDA |
| `smip_queue_oldest_waiting_seconds` | gauge | queue |
| `smip_job_duration_seconds` | histogram | queue, outcome |
| `smip_job_failures_total` | counter | queue, error_class |
| `smip_dlq_size` | gauge | queue |
| `smip_pipeline_dedupe_hits_total` | counter | platform |
| `smip_pipeline_match_ratio` | histogram | platform |
| `smip_sink_insert_rows_total` | counter | table |
| `smip_sink_insert_duration_seconds` | histogram | table |

### 3.3 AI
| Metric | Tipe | Label |
|---|---|---|
| `smip_ai_items_total` | counter | task (sentiment/emotion/gender/age_range/keyphrase/lang), model_version, source (model/llm/cache) |
| `smip_ai_batch_duration_seconds` | histogram | task |
| `smip_ai_low_confidence_ratio` | gauge | task, model_version |
| `smip_ai_coverage_ratio` | gauge | task (gender/age_range/emotion — porsi non-unknown) |
| `smip_llm_requests_total` | counter | model, outcome (ok/refusal/error/429) |
| `smip_llm_tokens_total` | counter | model, kind (input/output/cache_read) |
| `smip_sentiment_overrides_total` | counter | from, to |

### 3.4 API
`smip_http_requests_total{route,method,status}`, `smip_http_request_duration_seconds{route}`, `smip_sse_connections`, `smip_clickhouse_query_duration_seconds{query_name}`.

## 4. Tracing
Span utama: `scheduler.tick`, `dispatch.route`, `router.reserve`, `connector.fetch` (attribute: connector, operation, attempt, http.status), `pipeline.match`, `ai.enrich`, `llm.call`, `sink.insert`, `api.<route>`, `clickhouse.query`.
Sampling: 100% untuk error & failover, 10% sukses (config).

## 5. SLO

| SLO | Target awal | Pengukuran |
|---|---|---|
| API availability | 99.5% / 30 hari | `1 - 5xx/total` pada route non-admin |
| Dashboard latency | p95 ≤ 1.5 s (7 hari) | `smip_http_request_duration_seconds{route=~"/v1/analytics.*"}` |
| Data freshness | p95 ≤ interval + (p95 latency connector utama) + 120 s | `smip_data_freshness_seconds` |
| Ingest success | ≥ 99% run berakhir `succeeded|partial` per hari (di luar kasus semua provider down) | `smip_crawl_runs_total` |
| Failover time | p95 ≤ 2 menit dari error pertama ke attempt connector lain | trace |

Target direvisi setelah 4 minggu data produksi.

## 6. Alert (Alertmanager)

| Alert | Kondisi | Severity |
|---|---|---|
| `ProviderCircuitOpen` | `smip_circuit_state == 2` > 5m | warning |
| `PlatformNoHealthyProvider` | semua connector platform unhealthy > 5m | critical |
| `QuotaNearLimit` | `smip_quota_used_ratio > 0.8` | warning; `> 0.95` critical |
| `QueueBacklog` | `smip_queue_oldest_waiting_seconds{queue=~"fetch.*|pipeline.items|ai.enrich"}` > 2× interval terkecil aktif | warning |
| `DLQGrowing` | `increase(smip_dlq_size[15m]) > 0` | warning |
| `FreshnessSLOBurn` | burn rate 1h & 6h (multiwindow) | critical |
| `SchemaDrift` | `rate(smip_provider_requests_total{error_code="PARSE_ERROR"}[10m]) > 0` | warning |
| `AuthInvalidAccount` | account status `needs_attention` baru | warning |
| `LLMRefusalSpike` | refusal ratio > threshold | info |
| `ApiErrorRate` | 5xx > 2% 10m | critical |
| `ClickHouseInsertFailing` | sink failures > 0 selama 10m | critical |

Setiap alert punya link ke bagian RUNBOOK.

## 7. Dashboard Grafana
1. **Provider Health**: score, circuit, success rate, latency, failover sankey (from→to).
2. **Ingest Pipeline**: runs/status, coalesced/skipped, queue depth & oldest age, freshness heatmap per platform × interval.
3. **Cost & Quota**: request/result/cost units per connector per hari, quota burn-down.
4. **AI**: throughput, low-confidence ratio, LLM usage/token, distribusi label harian.
5. **API**: RPS, latency per route, error rate, SSE connections, ClickHouse query latency.
6. **Infra**: CPU/mem pod, Redis memory & evictions (harus 0), Postgres connections, ClickHouse parts/merges.

## 8. Audit vs Observability
Audit log (bisnis, siapa-mengubah-apa) disimpan di Postgres & tidak di-sample; observability boleh di-sample dan punya retensi pendek (log 14–30 hari, metrics 90 hari, traces 7 hari — sesuaikan kapasitas).
