# S-05 — demo KEDA di kind (2026-09-30)

Lingkungan: VPS dev 2 vCPU / 1,9 GB (ClickHouse dihentikan sementara), kind v0.33.0, KEDA (helm `kedacore/keda`),
Prometheus v3.5.0 di cluster, exporter `smip_queue_depth` (kode `BullMqQueue.depth` + Registry yang sama dengan scheduler) di jaringan
`kind`, Redis-queue dev (BullMQ asli). Manifest: `infra/k8s/keda/kind-demo/demo.yaml`; skrip: `scripts/keda-demo/`.

## Langkah & hasil
1. 18 job **ber-priority** di-enqueue ke `fetch.bun` (`scripts/keda-demo/load.ts`): `depth = {waiting: 0, prioritized: 18, backlog: 18}`,
   **`LLEN bull:fetch.bun:wait = 0`** → scaler Redis listLength akan melihat 0 (tidak pernah menskala).
2. ScaledObject Prometheus (`max(smip_queue_depth{queue="fetch.bun",state="backlog"})`, threshold 5, min 0 / max 4):

```
21:02:22 replicas= hpa=
21:02:27 replicas=4 hpa=18
21:02:33 replicas=4 hpa=18
```
   → **0 → 4 replika** (18/5 → 4; metrik HPA rata-rata 4,5/pod).
3. Job dihapus (backlog 0) → cooldown 30 s:

```
21:04:12 replicas=1
21:04:27 replicas=1
21:04:43 replicas=
21:04:58 replicas=
21:05:14 replicas=
21:05:29 replicas=
```
   → **4 → 1 → 0 replika**.

## Catatan
- Firewall host (ufw) memblok bridge Docker → port host; exporter dijalankan sebagai container di jaringan `kind` (tanpa mengubah
  firewall). Di Kubernetes sungguhan scheduler adalah pod → Prometheus men-scrape langsung.
- Keputusan S-05 terkonfirmasi end-to-end: **KEDA Prometheus scaler atas `smip_queue_depth{state="backlog"}`**.
