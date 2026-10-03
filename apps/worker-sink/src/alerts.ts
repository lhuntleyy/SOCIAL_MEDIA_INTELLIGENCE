// O-05 evaluator alert (API_SPEC §8, DATA_MODEL §5.4–5.6): tiap 5 menit, aturan aktif pada topik aktif dievaluasi atas agregat
// ClickHouse (hanya angka agregat — tidak ada data per akun di pesan). Terpenuhi & di luar cooldown → alert_events (open) +
// kirim ke saluran kantor (Telegram/webhook lewat @smip/notify; HTTP dengan guard SSRF). Hasil kirim dicatat di payload event.
//   negative_ratio : ≥ threshold_pct % post negatif dalam window_hours terakhir (min_posts)
//   volume_spike   : post dalam window_hours ≥ factor × rata-rata window yang sama selama 7 hari sebelumnya (min_posts)
//   new_issue      : isu dengan ≥ min_mentions dalam window_hours yang tidak muncul sama sekali 7 hari sebelumnya
import type { ClickHouseClient } from "@clickhouse/client";
import { credentialAad, type KmsAdapter, open } from "@smip/crypto";
import { type Db, type Tx, withSystem } from "@smip/db";
import { type AlertMessage, type ChannelTarget, type Delivery, deliver, type Post } from "@smip/notify";
import { sql } from "drizzle-orm";
import { chTime } from "./sink";

export type AlertType = "negative_ratio" | "volume_spike" | "new_issue";

export interface RuleRow {
  id: string;
  tenant_id: string;
  tenant_name: string;
  topic_id: string;
  topic_name: string;
  type: AlertType | string;
  params: Record<string, number>;
  channels: string[];
}

export interface Finding {
  title: string;
  message: string;
  metrics: Record<string, unknown>;
}

/** Query agregat (diinjeksi → evaluator bisa diuji tanpa ClickHouse). */
export type AggQuery = <T>(query: string, params: Record<string, unknown>) => Promise<T[]>;

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const hrs = (h: number) => (h === 1 ? "1 jam" : `${h} jam`);

export async function checkRule(q: AggQuery, r: RuleRow, now: Date): Promise<Finding | null> {
  const p = r.params ?? {};
  const wh = Math.min(72, Math.max(1, Number(p.window_hours ?? (r.type === "new_issue" ? 6 : r.type === "volume_spike" ? 1 : 3))));
  const to = now;
  const from = new Date(now.getTime() - wh * 3_600_000);
  const base = { t: r.tenant_id, topic: r.topic_id, from: chTime(from.toISOString()), to: chTime(to.toISOString()) };
  if (r.type === "negative_ratio") {
    const [x] = await q<{ n: string; neg: string }>(
      `SELECT sum(posts) AS n, sumIf(posts, sentiment = 'negative') AS neg FROM agg_topic_1h
       WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND bucket >= toStartOfHour({from:DateTime64(3)}) AND bucket <= {to:DateTime64(3)}`,
      base,
    );
    const n = Number(x?.n ?? 0);
    const neg = Number(x?.neg ?? 0);
    const share = pct(neg, n);
    if (n < Number(p.min_posts ?? 20) || share < Number(p.threshold_pct ?? 50)) return null;
    return {
      title: `Sentimen negatif ${share}% (${hrs(wh)} terakhir)`,
      message: `${neg} dari ${n} post bernada negatif — di atas ambang ${Number(p.threshold_pct ?? 50)}%.`,
      metrics: { posts: n, negative: neg, negative_pct: share, window_hours: wh },
    };
  }
  if (r.type === "volume_spike") {
    const histFrom = new Date(from.getTime() - 7 * 86_400_000);
    const [x] = await q<{ cur: string; hist: string }>(
      `SELECT sumIf(posts, bucket >= toStartOfHour({from:DateTime64(3)})) AS cur,
              sumIf(posts, bucket < toStartOfHour({from:DateTime64(3)})) AS hist
       FROM agg_topic_1h
       WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND bucket >= toStartOfHour({hf:DateTime64(3)}) AND bucket <= {to:DateTime64(3)}`,
      { ...base, hf: chTime(histFrom.toISOString()) },
    );
    const cur = Number(x?.cur ?? 0);
    const avg = Number(x?.hist ?? 0) / ((7 * 24) / wh);
    const factor = Number(p.factor ?? 3);
    if (cur < Number(p.min_posts ?? 30) || cur < factor * Math.max(avg, 1)) return null;
    const times = Math.round((cur / Math.max(avg, 1)) * 10) / 10;
    return {
      title: `Lonjakan percakapan ${times}× (${hrs(wh)} terakhir)`,
      message: `${cur} post dalam ${hrs(wh)} terakhir, biasanya ± ${Math.round(avg)} (rata-rata 7 hari).`,
      metrics: { posts: cur, baseline: Math.round(avg * 10) / 10, factor: times, window_hours: wh },
    };
  }
  if (r.type === "new_issue") {
    const histFrom = new Date(from.getTime() - 7 * 86_400_000);
    const rows = await q<{ issue: string; n: string }>(
      `SELECT issue, sumIf(mentions, bucket >= toStartOfHour({from:DateTime64(3)})) AS n,
              sumIf(mentions, bucket < toStartOfHour({from:DateTime64(3)})) AS before
       FROM agg_issue_1h
       WHERE tenant_id = {t:UUID} AND topic_id = {topic:UUID} AND bucket >= toStartOfHour({hf:DateTime64(3)}) AND bucket <= {to:DateTime64(3)}
       GROUP BY issue HAVING n >= {min:UInt32} AND before = 0 ORDER BY n DESC LIMIT 5`,
      { ...base, hf: chTime(histFrom.toISOString()), min: Number(p.min_mentions ?? 10) },
    );
    if (!rows.length) return null;
    const list = rows.map((x) => `${x.issue} (${x.n})`).join(", ");
    return {
      title: `Isu baru muncul: ${rows[0]!.issue}`,
      message: `Isu yang belum pernah muncul 7 hari terakhir: ${list}.`,
      metrics: { issues: rows.map((x) => ({ issue: x.issue, mentions: Number(x.n) })), window_hours: wh },
    };
  }
  return null;
}

async function openSecret(kms: KmsAdapter, tx: Tx, credentialId: string): Promise<Record<string, string> | null> {
  const [c] = (await tx.execute(
    sql`select id, tenant_id, ciphertext, iv, wrapped_dek, kek_id, aad from credentials where id = ${credentialId}`,
  )) as unknown as {
    id: string;
    tenant_id: string | null;
    ciphertext: Uint8Array;
    iv: Uint8Array;
    wrapped_dek: Uint8Array | null;
    kek_id: string;
    aad: string;
  }[];
  if (!c?.wrapped_dek) return null;
  return open<Record<string, string>>(
    kms,
    {
      ciphertext: new Uint8Array(c.ciphertext),
      iv: new Uint8Array(c.iv),
      wrapped_dek: new Uint8Array(c.wrapped_dek),
      kek_id: c.kek_id,
      aad: c.aad,
    },
    credentialAad(c.id, c.tenant_id),
  );
}

/** Target saluran milik tenant (secret dibuka sesaat di memori). */
export async function loadTargets(db: Db, kms: KmsAdapter | null, tenantId: string, ids: string[]): Promise<ChannelTarget[]> {
  if (!ids.length) return [];
  return withSystem(db, async (tx) => {
    const rows = (await tx.execute(sql`select id, kind, config, credential_id from notification_channels
      where tenant_id = ${tenantId} and enabled and id = any(${`{${ids.join(",")}}`}::uuid[])`)) as unknown as {
      id: string;
      kind: ChannelTarget["kind"];
      config: ChannelTarget["config"];
      credential_id: string | null;
    }[];
    const out: ChannelTarget[] = [];
    for (const r of rows)
      out.push({
        id: r.id,
        kind: r.kind,
        config: r.config ?? {},
        secret: r.credential_id && kms ? await openSecret(kms, tx, r.credential_id) : null,
      });
    return out;
  });
}

export interface AlertDeps {
  db: Db;
  ch: ClickHouseClient;
  kms: KmsAdapter | null;
  post: Post;
  /** URL dasar dashboard untuk tautan di pesan (opsional) */
  appUrl?: string;
  now?: () => Date;
}

export interface AlertTickResult {
  evaluated: number;
  fired: number;
  deliveries: Record<Delivery["status"], number>;
}

export async function evaluateAlerts(d: AlertDeps): Promise<AlertTickResult> {
  const now = d.now?.() ?? new Date();
  const res: AlertTickResult = { evaluated: 0, fired: 0, deliveries: { sent: 0, failed: 0, skipped: 0 } };
  const rules = await withSystem(
    d.db,
    async (tx) =>
      (await tx.execute(sql`
      select r.id, r.tenant_id, tn.name as tenant_name, r.topic_id, t.name as topic_name, r.type::text as type, r.params,
             to_jsonb(r.channels) as channels
      from alert_rules r join topics t on t.id = r.topic_id join tenants tn on tn.id = r.tenant_id
      where r.enabled and t.status = 'active' and t.deleted_at is null and tn.status = 'active'
        and not exists (select 1 from alert_events e where e.rule_id = r.id
                        and e.fired_at > ${now.toISOString()}::timestamptz - make_interval(secs => r.cooldown_sec))`)) as unknown as RuleRow[],
  );
  const q: AggQuery = async (query, params) => (await d.ch.query({ query, query_params: params, format: "JSONEachRow" })).json() as never;
  for (const r of rules) {
    res.evaluated++;
    const f = await checkRule(q, r, now);
    if (!f) continue;
    const eventId = Bun.randomUUIDv7();
    const msg: AlertMessage = {
      event_id: eventId,
      type: r.type,
      title: f.title,
      message: f.message,
      topic: { id: r.topic_id, name: r.topic_name },
      office: r.tenant_name,
      fired_at: now.toISOString(),
      ...(d.appUrl ? { link: `${d.appUrl.replace(/\/$/, "")}/?topic=${r.topic_id}` } : {}),
      metrics: f.metrics,
    };
    await withSystem(d.db, (tx) =>
      tx.execute(sql`insert into alert_events (id, tenant_id, rule_id, fired_at, payload)
        values (${eventId}, ${r.tenant_id}, ${r.id}, ${now.toISOString()}::timestamptz, ${JSON.stringify({ ...msg, deliveries: [] })}::text::jsonb)`),
    );
    res.fired++;
    const deliveries: Delivery[] = [];
    for (const c of await loadTargets(d.db, d.kms, r.tenant_id, r.channels ?? [])) {
      const x = await deliver(c, msg, d.post, now);
      deliveries.push(x);
      res.deliveries[x.status]++;
    }
    if (deliveries.length)
      await withSystem(d.db, (tx) =>
        tx.execute(sql`update alert_events set payload = jsonb_set(payload, '{deliveries}', ${JSON.stringify(deliveries)}::text::jsonb)
          where id = ${eventId}`),
      );
  }
  return res;
}
