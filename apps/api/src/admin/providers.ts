// I-21 Admin API provider management (API_SPEC §9). Operator platform untuk semua; admin tenant hanya akun BYO tenant-nya.
// Semua perubahan config ditulis bersama outbox (snapshot router ter-invalidasi ≤ 30 s, R-12) + audit (SECURITY §8).
// Secret credential WRITE-ONLY: tidak pernah dikembalikan, di-log, atau masuk audit (SEC-02).

import { HttpClient } from "@smip/connector-sdk";
import type { Operation } from "@smip/contracts";
import type { QueueName, RouteInput } from "@smip/core";
import type { KmsAdapter } from "@smip/crypto";
import {
  auditLogs,
  type Db,
  inList,
  loadRoutingSnapshot,
  readSettings,
  SETTING_DEFAULTS,
  type Tx,
  withSystem,
  writeJobOutbox,
  writeOutbox,
} from "@smip/db";
import { evaluate, type HealthState } from "@smip/router";
import { sql } from "drizzle-orm";
import { ApiError } from "../errors";
import { sealCredential } from "./credentials";
import type { Actor } from "./service";

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as T[];

function pgCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const c = cur as { code?: string; errno?: string; cause?: unknown };
    if (typeof c.errno === "string" && /^[0-9A-Z]{5}$/.test(c.errno)) return c.errno;
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code)) return c.code;
    cur = c.cause;
  }
  return undefined;
}

// ---------- validasi config connector terhadap config_schema (subset JSON Schema yang dipakai manifest) ----------
type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  maxLength?: number;
  pattern?: string;
  enum?: unknown[];
  items?: JsonSchema;
};

export function validateAgainstSchema(schema: JsonSchema, v: unknown, path = "config"): { path: string; issue: string }[] {
  const out: { path: string; issue: string }[] = [];
  const t = schema.type;
  const typeOk =
    !t ||
    (t === "object" && v !== null && typeof v === "object" && !Array.isArray(v)) ||
    (t === "array" && Array.isArray(v)) ||
    (t === "string" && typeof v === "string") ||
    (t === "boolean" && typeof v === "boolean") ||
    (t === "number" && typeof v === "number" && Number.isFinite(v)) ||
    (t === "integer" && Number.isInteger(v));
  if (!typeOk) return [{ path, issue: `harus ${t}` }];
  if (schema.enum && !schema.enum.includes(v)) out.push({ path, issue: `harus salah satu: ${schema.enum.join(", ")}` });
  if (typeof v === "number") {
    if (schema.minimum !== undefined && v < schema.minimum) out.push({ path, issue: `≥ ${schema.minimum}` });
    if (schema.maximum !== undefined && v > schema.maximum) out.push({ path, issue: `≤ ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum) out.push({ path, issue: `> ${schema.exclusiveMinimum}` });
  }
  if (typeof v === "string") {
    if (schema.maxLength !== undefined && v.length > schema.maxLength) out.push({ path, issue: `panjang ≤ ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) out.push({ path, issue: "format tidak valid" });
  }
  if (t === "object" && v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) out.push({ path: `${path}.${r}`, issue: "wajib" });
    for (const [k, x] of Object.entries(o)) {
      const p = schema.properties?.[k];
      if (!p) {
        if (schema.additionalProperties === false) out.push({ path: `${path}.${k}`, issue: "properti tidak dikenal" });
        continue;
      }
      out.push(...validateAgainstSchema(p, x, `${path}.${k}`));
    }
  }
  if (t === "array" && Array.isArray(v) && schema.items)
    for (const [i, x] of v.entries()) out.push(...validateAgainstSchema(schema.items, x, `${path}[${i}]`));
  return out;
}

/** SEC-07: nilai config berbentuk URL harus lolos guard SSRF (https, tanpa kredensial, bukan IP privat). */
async function assertConfigUrlsSafe(v: unknown, http: HttpClient, path = "config"): Promise<void> {
  if (typeof v === "string" && /^[a-z]+:\/\//i.test(v)) {
    try {
      await http.assertSafeUrl(v);
    } catch (e) {
      throw new ApiError("VALIDATION_FAILED", "URL di config ditolak (SSRF guard)", [{ path, issue: (e as Error).message }]);
    }
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) await assertConfigUrlsSafe(x, http, `${path}.${k}`);
  }
}

export interface ProviderAdminOptions {
  kms: KmsAdapter;
  /** Pepper HMAC fingerprint credential (deteksi duplikat tanpa dekripsi). */
  fingerprintPepper: Uint8Array<ArrayBuffer>;
  http?: HttpClient;
  dlq?: {
    listDlq(queue: QueueName, limit?: number): Promise<unknown[]>;
    redrive(queue: QueueName, jobId: string): Promise<string>;
    discard(queue: QueueName, jobId: string): Promise<void>;
  };
}

export interface HealthParams {
  failures?: number;
  minSuccessRate?: number;
  probeSuccesses?: number;
  cooldownMs?: number;
  cooldownCapMs?: number;
}

export class ProviderAdminService {
  private readonly http: HttpClient;
  constructor(
    private readonly db: Db,
    private readonly o: ProviderAdminOptions,
  ) {
    this.http = o.http ?? new HttpClient();
  }

  private sys<T>(fn: (tx: Tx) => Promise<T>) {
    return withSystem(this.db, fn);
  }
  private async audit(tx: Tx, a: Actor, action: string, target: { type: string; id: string }, after?: unknown, tenantId?: string | null) {
    await tx.insert(auditLogs).values({
      id: Bun.randomUUIDv7(),
      tenantId: tenantId === undefined ? a.tenantId : tenantId,
      actorType: "user",
      actorId: a.userId,
      action,
      targetType: target.type,
      targetId: target.id,
      after: after ?? null,
      ip: a.ip ?? null,
      userAgent: a.ua ?? null,
      requestId: a.requestId ?? null,
    });
  }

  // ---------- providers ----------
  listProviders() {
    return this.sys((tx) =>
      rows(
        tx,
        sql`select p.id, p.key, p.name, p.kind, p.risk_level, p.enabled, p.notes, p.docs_url,
                 (select count(*)::int from connectors c where c.provider_id = p.id) as connectors,
                 (select coalesce(jsonb_object_agg(state, n), '{}'::jsonb) from (
                    select h.state, count(*)::int as n from provider_health h join connectors c on c.id = h.connector_id
                    where c.provider_id = p.id group by h.state) x) as health
          from providers p order by p.key`,
      ),
    );
  }

  /** Pengaturan per platform (migrasi 0023): batas post per pengambilan. */
  listPlatforms() {
    return this.sys((tx) =>
      rows(tx, sql`select code, name, enabled, max_items_per_run, crawl_interval_sec from platforms order by sort_order, code`),
    );
  }

  async patchPlatform(a: Actor, code: string, b: { max_items_per_run?: number | null; crawl_interval_sec?: number | null }) {
    return this.sys(async (tx) => {
      const r = await rows(
        tx,
        sql`update platforms set max_items_per_run = ${b.max_items_per_run === undefined ? sql`max_items_per_run` : b.max_items_per_run},
              crawl_interval_sec = ${b.crawl_interval_sec === undefined ? sql`crawl_interval_sec` : b.crawl_interval_sec}
            where code = ${code} returning code, name, enabled, max_items_per_run, crawl_interval_sec`,
      );
      if (!r.length) throw new ApiError("NOT_FOUND", "Platform tidak ditemukan");
      if (b.crawl_interval_sec !== undefined) {
        // interval platform = kebijakan owner untuk SEMUA topik: interval per-topik lama dilepas, plan & stream ikut sekarang
        // (jadwal berikutnya tidak lebih lambat dari interval baru). null → kembali ke interval bawaan topik.
        await tx.execute(sql`update topic_platforms set interval_sec = null where platform_code = ${code}`);
        await tx.execute(sql`update crawl_plans cp set interval_sec = coalesce(${b.crawl_interval_sec}::int, t.default_interval_sec),
            next_run_at = least(cp.next_run_at, now() + make_interval(secs => coalesce(${b.crawl_interval_sec}::int, t.default_interval_sec))),
            updated_at = now()
          from topics t where t.id = cp.topic_id and cp.platform_code = ${code} and cp.status <> 'disabled'`);
        if (b.crawl_interval_sec !== null)
          await tx.execute(sql`update collection_streams set interval_sec = ${b.crawl_interval_sec},
              next_run_at = least(next_run_at, now() + make_interval(secs => ${b.crawl_interval_sec}::int))
            where platform_code = ${code}`);
      }
      await this.audit(tx, a, "platform.update", { type: "platform", id: code }, b, null);
      return r[0]!;
    });
  }

  async getSettings() {
    return this.sys(async (tx) => {
      const values = await readSettings(tx);
      const set = (await tx.execute(sql`select key from system_settings`)) as unknown as { key: string }[];
      return { values, defaults: SETTING_DEFAULTS, overridden: set.map((s) => s.key) };
    });
  }

  async putSettings(a: Actor, values: Record<string, unknown>) {
    await this.sys(async (tx) => {
      for (const [k, v] of Object.entries(values)) {
        if (!(k in SETTING_DEFAULTS)) continue;
        if (v === null || v === undefined) await tx.execute(sql`delete from system_settings where key = ${k}`);
        else
          await tx.execute(sql`insert into system_settings (key, value, updated_by) values (${k}, ${JSON.stringify(v)}::text::jsonb, ${a.userId})
            on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`);
      }
      await this.audit(tx, a, "settings.update", { type: "system_settings", id: "global" }, values, null);
    });
    return this.getSettings();
  }

  async patchProvider(a: Actor, id: string, b: { enabled?: boolean; risk_level?: "low" | "medium" | "high"; notes?: string | null }) {
    return this.sys(async (tx) => {
      let r: Row[];
      try {
        r = await rows(
          tx,
          sql`update providers set enabled = coalesce(${b.enabled ?? null}, enabled), risk_level = coalesce(${b.risk_level ?? null}::e_risk, risk_level),
              notes = ${b.notes === undefined ? sql`notes` : b.notes}, updated_at = now() where id = ${id}
            returning id, key, kind, risk_level, enabled, notes`,
        );
      } catch (e) {
        // CHECK: provider unofficial wajib risk_level high
        if (pgCode(e) === "23514")
          throw new ApiError("VALIDATION_FAILED", "Provider unofficial wajib risk_level high", [{ path: "risk_level", issue: "high" }]);
        throw e;
      }
      if (!r.length) throw new ApiError("NOT_FOUND", "Provider tidak ditemukan");
      await writeOutbox(tx, { aggregate: "provider", aggregateId: id, eventType: "provider.updated", payload: { fields: Object.keys(b) } });
      await this.audit(tx, a, "provider.update", { type: "provider", id }, b, null);
      return r[0]!;
    });
  }

  // ---------- connectors ----------
  private async connectorRows(tx: Tx, where: ReturnType<typeof sql>) {
    const cs = await rows(
      tx,
      sql`select c.id, c.key, c.platform_code as platform, c.runtime, c.version, c.enabled, c.config, c.config_schema,
               jsonb_build_object('id', p.id, 'key', p.key, 'kind', p.kind, 'enabled', p.enabled) as provider
        from connectors c join providers p on p.id = c.provider_id where ${where} order by c.key`,
    );
    if (!cs.length) return [];
    const ids = cs.map((c) => String(c.id));
    const caps = await rows(
      tx,
      sql`select connector_id, operation, status, verified_at, measured, declared, evidence_ref from connector_capabilities
        where connector_id in ${inList(ids)} order by operation`,
    );
    const health = await rows(
      tx,
      sql`select h.connector_id, h.provider_account_key as account_id, pa.label as account_label, h.state, h.circuit, h.score,
               h.success_rate_5m, h.p95_latency_ms, h.last_error_code
        from provider_health h left join provider_accounts pa on pa.id = h.provider_account_key where h.connector_id in ${inList(ids)}`,
    );
    const rl = await rows(
      tx,
      sql`select scope_type as scope, scope_id, algorithm, capacity, refill_tokens, refill_interval_ms, source, source_ref, enabled
        from rate_limit_policies where scope_id in ${inList(ids)} or scope_id in (select provider_id from connectors where id in ${inList(ids)})`,
    );
    const quota = await rows(
      tx,
      sql`select qp.scope_type as scope, qp.scope_id, qp.period, qp.unit, qp.limit_value::float8 as limit, qp.hard,
               (select u.used::float8 from quota_usage u where u.scope_type = qp.scope_type and u.scope_id = qp.scope_id and u.period = qp.period
                  and u.unit = qp.unit order by u.period_start desc limit 1) as used
        from quota_policies qp where qp.enabled and qp.scope_id in ${inList(ids)}`,
    );
    return cs.map((c) => {
      const { config_schema: schema, ...rest } = c;
      // batas yang bisa diatur owner (Pengaturan → Batas & jadwal): hanya properti angka/boolean, tanpa schema lengkap
      const props = ((schema as { properties?: Record<string, Record<string, unknown>> } | null)?.properties ?? {}) as Record<
        string,
        { type?: string; minimum?: number; maximum?: number; description?: string }
      >;
      const config_fields = Object.entries(props)
        .filter(([, p]) => p.type === "integer" || p.type === "number" || p.type === "boolean")
        .map(([key, p]) => ({
          key,
          type: p.type,
          minimum: p.minimum ?? null,
          maximum: p.maximum ?? null,
          description: p.description ?? null,
        }));
      return {
        ...rest,
        config_fields,
        capabilities: caps.filter((x) => x.connector_id === c.id).map(({ connector_id: _c, ...x }) => x),
        health: health.filter((x) => x.connector_id === c.id).map(({ connector_id: _c, ...x }) => x),
        rate_limits: rl.filter((x) => x.scope_id === c.id || x.scope_id === (c.provider as { id: string }).id),
        quota: quota.filter((x) => x.scope_id === c.id),
      };
    });
  }

  listConnectors(q: { platform?: string; provider?: string }) {
    return this.sys((tx) =>
      this.connectorRows(
        tx,
        sql`true ${q.platform ? sql`and c.platform_code = ${q.platform}` : sql``} ${q.provider ? sql`and p.key = ${q.provider}` : sql``}`,
      ),
    );
  }

  async getConnector(id: string) {
    const [c] = await this.sys((tx) => this.connectorRows(tx, sql`c.id = ${id}`));
    if (!c) throw new ApiError("NOT_FOUND", "Connector tidak ditemukan");
    return c;
  }

  async patchConnector(a: Actor, id: string, b: { enabled?: boolean; config?: Record<string, unknown>; health?: HealthParams }) {
    return this.sys(async (tx) => {
      const [c] = await rows<{ config: Record<string, unknown>; config_schema: JsonSchema }>(
        tx,
        sql`select config, config_schema from connectors where id = ${id} for update`,
      );
      if (!c) throw new ApiError("NOT_FOUND", "Connector tidak ditemukan");
      let config = c.config ?? {};
      if (b.config) {
        const issues = validateAgainstSchema(c.config_schema ?? {}, b.config);
        if (issues.length) throw new ApiError("VALIDATION_FAILED", "Config tidak sesuai config_schema connector", issues);
        await assertConfigUrlsSafe(b.config, this.http);
        config = { ...b.config, ...(config.health ? { health: config.health } : {}) };
      }
      if (b.health) config = { ...config, health: { ...((config.health as object) ?? {}), ...b.health } };
      await tx.execute(sql`update connectors set enabled = coalesce(${b.enabled ?? null}, enabled), config = ${JSON.stringify(config)}::text::jsonb,
        updated_at = now() where id = ${id}`);
      await writeOutbox(tx, {
        aggregate: "connector",
        aggregateId: id,
        eventType: "connector.updated",
        payload: { fields: Object.keys(b) },
      });
      // nilai config bukan secret (secret hanya di credentials) — tetap dicatat nama field saja agar audit ringkas
      await this.audit(
        tx,
        a,
        "connector.update",
        { type: "connector", id },
        { enabled: b.enabled, config_keys: b.config ? Object.keys(b.config) : undefined, health: b.health },
        null,
      );
      const [out] = await this.connectorRows(tx, sql`c.id = ${id}`);
      return out!;
    });
  }

  /** health-check / verify → job via outbox (API tidak memanggil provider langsung — Golden Rule 5). */
  async enqueueConnectorJob(
    a: Actor,
    id: string,
    kind: "health.probe" | "connector.verify",
    verify?: { query: string; operation?: Operation; samples: number; max_items: number; window_hours: number; apply: boolean },
  ) {
    return this.sys(async (tx) => {
      const [c] = await rows(tx, sql`select id, key from connectors where id = ${id}`);
      if (!c) throw new ApiError("NOT_FOUND", "Connector tidak ditemukan");
      const jobId = Bun.randomUUIDv7();
      await writeJobOutbox(tx, id, {
        queue: kind,
        idempotencyKey: `${kind === "health.probe" ? "hp" : "cv"}.${id}.${jobId}`,
        type: kind,
        tenantId: null,
        payload: { connector_id: id, requested_by: a.userId, job_id: jobId, ...(kind === "connector.verify" ? verify : {}) },
      });
      await this.audit(
        tx,
        a,
        kind === "health.probe" ? "connector.health_check" : "connector.verify",
        { type: "connector", id },
        verify,
        null,
      );
      return { job_id: jobId, status: "queued" };
    });
  }

  // ---------- accounts (operator: semua; admin tenant: hanya BYO miliknya) ----------
  private scope(a: Actor & { op: boolean }) {
    return a.op ? sql`true` : sql`pa.tenant_id = ${a.tenantId}`;
  }

  listAccounts(a: Actor & { op: boolean }, q: { provider?: string; status?: string }) {
    return this.sys((tx) =>
      rows(
        tx,
        sql`select pa.id, pa.tenant_id, pa.provider_id, p.key as provider_key, pa.label, pa.status, pa.display_hint, pa.cooldown_until,
                 pa.attention_reason, pa.allowed_connector_ids, pa.last_used_at, pa.created_at,
                 jsonb_build_object('kind', c.kind, 'created_at', c.created_at, 'rotated_at', c.rotated_at) as credential
          from provider_accounts pa join providers p on p.id = pa.provider_id join credentials c on c.id = pa.credential_id
          where ${this.scope(a)} ${q.provider ? sql`and p.key = ${q.provider}` : sql``}
            ${q.status ? sql`and pa.status = ${q.status}::e_account_status` : sql``}
          order by p.key, pa.label`,
      ),
    );
  }

  private sealCredential(tx: Tx, tenantId: string | null, kind: string, secret: Record<string, string>) {
    return sealCredential(this.o, tx, tenantId, kind, secret);
  }

  async createAccount(
    a: Actor & { op: boolean },
    b: {
      provider_id: string;
      label: string;
      tenant_id?: string | null;
      credential: { kind: string; secret: Record<string, string> };
      allowed_connector_ids?: string[] | null;
    },
  ) {
    // admin tenant hanya boleh membuat akun BYO untuk tenant-nya sendiri; shared pool (tenant null) khusus operator
    const tenantId = a.op ? (b.tenant_id ?? null) : a.tenantId;
    if (!a.op && b.tenant_id !== undefined && b.tenant_id !== a.tenantId)
      throw new ApiError("FORBIDDEN", "Hanya akun BYO untuk tenant sendiri");
    return this.sys(async (tx) => {
      const [p] = await rows(tx, sql`select id from providers where id = ${b.provider_id}`);
      if (!p) throw new ApiError("VALIDATION_FAILED", "Provider tidak dikenal", [{ path: "provider_id", issue: "tidak ada" }]);
      const cred = await this.sealCredential(tx, tenantId, b.credential.kind, b.credential.secret);
      const id = Bun.randomUUIDv7();
      await tx.execute(sql`insert into provider_accounts (id, tenant_id, provider_id, label, credential_id, display_hint, allowed_connector_ids)
        values (${id}, ${tenantId}, ${b.provider_id}, ${b.label}, ${cred.id}, ${cred.hint}, ${b.allowed_connector_ids ? sql`${`{${b.allowed_connector_ids.join(",")}}`}::uuid[]` : null})`);
      await writeOutbox(tx, { aggregate: "provider_account", aggregateId: id, eventType: "account.created" });
      await this.audit(
        tx,
        a,
        "account.create",
        { type: "provider_account", id },
        { provider_id: b.provider_id, label: b.label, tenant_id: tenantId, kind: b.credential.kind },
        tenantId,
      );
      return {
        id,
        label: b.label,
        tenant_id: tenantId,
        status: "active",
        display_hint: cred.hint,
        credential: { kind: b.credential.kind },
      };
    });
  }

  private async lockAccount(tx: Tx, a: Actor & { op: boolean }, id: string) {
    const [acc] = await rows<{ id: string; tenant_id: string | null; credential_id: string; status: string }>(
      tx,
      sql`select pa.id, pa.tenant_id, pa.credential_id, pa.status from provider_accounts pa where pa.id = ${id} and ${this.scope(a)} for update`,
    );
    if (!acc) throw new ApiError("NOT_FOUND", "Akun tidak ditemukan");
    return acc;
  }

  async patchAccount(
    a: Actor & { op: boolean },
    id: string,
    b: { status?: "active" | "disabled"; label?: string; allowed_connector_ids?: string[] | null },
  ) {
    return this.sys(async (tx) => {
      const acc = await this.lockAccount(tx, a, id);
      if (acc.status === "revoked") throw new ApiError("CONFLICT", "Akun sudah dicabut");
      await tx.execute(sql`update provider_accounts set status = coalesce(${b.status ?? null}::e_account_status, status), label = coalesce(${b.label ?? null}, label),
        allowed_connector_ids = ${b.allowed_connector_ids === undefined ? sql`allowed_connector_ids` : b.allowed_connector_ids === null ? null : sql`${`{${b.allowed_connector_ids.join(",")}}`}::uuid[]`},
        attention_reason = case when ${b.status ?? null}::e_account_status = 'active' then null else attention_reason end,
        cooldown_until = case when ${b.status ?? null}::e_account_status = 'active' then null else cooldown_until end, updated_at = now() where id = ${id}`);
      await writeOutbox(tx, { aggregate: "provider_account", aggregateId: id, eventType: "account.updated" });
      await this.audit(tx, a, "account.update", { type: "provider_account", id }, b, acc.tenant_id);
      const [out] = await rows(
        tx,
        sql`select id, label, status, display_hint, allowed_connector_ids from provider_accounts where id = ${id}`,
      );
      return out!;
    });
  }

  /** Rotasi: credential baru disegel; credential lama di-crypto-shred (wrapped_dek NULL → tak bisa didekripsi lagi). */
  async rotateCredential(a: Actor & { op: boolean }, id: string, b: { kind: string; secret: Record<string, string> }) {
    return this.sys(async (tx) => {
      const acc = await this.lockAccount(tx, a, id);
      if (acc.status === "revoked") throw new ApiError("CONFLICT", "Akun sudah dicabut");
      const cred = await this.sealCredential(tx, acc.tenant_id, b.kind, b.secret);
      await tx.execute(sql`update provider_accounts set credential_id = ${cred.id}, display_hint = ${cred.hint},
        status = case when status in ('needs_attention') then 'active' else status end, attention_reason = null, updated_at = now() where id = ${id}`);
      await tx.execute(sql`update credentials set wrapped_dek = null, rotated_at = now() where id = ${acc.credential_id}`);
      await writeOutbox(tx, { aggregate: "provider_account", aggregateId: id, eventType: "account.rotated" });
      await this.audit(tx, a, "account.rotate_credential", { type: "provider_account", id }, { kind: b.kind }, acc.tenant_id);
      return { id, display_hint: cred.hint, credential: { kind: b.kind, rotated: true } };
    });
  }

  async revokeAccount(a: Actor & { op: boolean }, id: string) {
    await this.sys(async (tx) => {
      const acc = await this.lockAccount(tx, a, id);
      await tx.execute(sql`update provider_accounts set status = 'revoked', updated_at = now() where id = ${id}`);
      await tx.execute(sql`update credentials set wrapped_dek = null where id = ${acc.credential_id}`); // hapus kriptografis
      await writeOutbox(tx, { aggregate: "provider_account", aggregateId: id, eventType: "account.revoked" });
      await this.audit(tx, a, "account.revoke", { type: "provider_account", id }, undefined, acc.tenant_id);
    });
  }

  // ---------- routing policies ----------
  listPolicies(q: { platform?: string; operation?: string; tenant_id?: string }) {
    return this.sys(async (tx) => {
      const ps = await rows(
        tx,
        sql`select id, tenant_id, platform_code as platform, operation, strategy, failover_enabled, max_attempts, allow_unverified, enabled, version, updated_at
          from routing_policies where true
            ${q.platform ? sql`and platform_code = ${q.platform}` : sql``} ${q.operation ? sql`and operation = ${q.operation}` : sql``}
            ${q.tenant_id ? sql`and tenant_id = ${q.tenant_id}` : sql``}
          order by platform_code, operation, tenant_id nulls first`,
      );
      const ids = ps.map((p) => String(p.id));
      const rules = ids.length
        ? await rows(
            tx,
            sql`select r.policy_id, r.id, r.connector_id, c.key as connector_key, r.priority, r.weight, r.enabled, r.max_share_pct, r.conditions
              from routing_rules r join connectors c on c.id = r.connector_id where r.policy_id in ${inList(ids)} order by r.priority, r.weight desc`,
          )
        : [];
      return ps.map((p) => ({ ...p, rules: rules.filter((r) => r.policy_id === p.id).map(({ policy_id: _p, ...r }) => r) }));
    });
  }

  async replacePolicy(
    a: Actor,
    id: string,
    b: {
      strategy: "priority_weighted" | "round_robin" | "cost_aware";
      failover_enabled: boolean;
      max_attempts: number;
      allow_unverified: boolean;
      enabled: boolean;
      rules: {
        connector_id: string;
        priority: number;
        weight: number;
        enabled: boolean;
        max_share_pct?: number | null;
        run_kinds?: string[] | null;
      }[];
    },
    ifMatch?: number,
  ) {
    return this.sys(async (tx) => {
      const [p] = await rows<{ version: number; platform_code: string; operation: string }>(
        tx,
        sql`select version, platform_code, operation from routing_policies where id = ${id} for update`,
      );
      if (!p) throw new ApiError("NOT_FOUND", "Routing policy tidak ditemukan");
      if (ifMatch === undefined)
        throw new ApiError("VALIDATION_FAILED", "Header If-Match wajib (versi policy)", [{ path: "If-Match", issue: "wajib" }]);
      if (p.version !== ifMatch) throw new ApiError("VERSION_MISMATCH", `Versi berubah (sekarang ${p.version})`);
      const ids = b.rules.map((r) => r.connector_id);
      if (new Set(ids).size !== ids.length)
        throw new ApiError("VALIDATION_FAILED", "Connector duplikat di rules", [{ path: "rules", issue: "duplikat" }]);
      const conns = ids.length
        ? await rows<{ id: string; platform_code: string }>(tx, sql`select id, platform_code from connectors where id in ${inList(ids)}`)
        : [];
      const bad = ids.filter((cid) => !conns.some((c) => c.id === cid && c.platform_code === p.platform_code));
      if (bad.length)
        throw new ApiError(
          "VALIDATION_FAILED",
          "Connector tidak dikenal / beda platform",
          bad.map((x) => ({ path: "rules", issue: x })),
        );
      await tx.execute(sql`update routing_policies set strategy = ${b.strategy}::e_strategy, failover_enabled = ${b.failover_enabled},
        max_attempts = ${b.max_attempts}, allow_unverified = ${b.allow_unverified}, enabled = ${b.enabled}, version = version + 1,
        updated_by = ${a.userId}, updated_at = now() where id = ${id}`);
      await tx.execute(sql`delete from routing_rules where policy_id = ${id}`);
      for (const r of b.rules) {
        await tx.execute(sql`insert into routing_rules (id, policy_id, connector_id, priority, weight, enabled, max_share_pct, conditions)
          values (${Bun.randomUUIDv7()}, ${id}, ${r.connector_id}, ${r.priority}, ${r.weight}, ${r.enabled}, ${r.max_share_pct ?? null},
                  ${JSON.stringify(r.run_kinds ? { run_kinds: r.run_kinds } : {})}::text::jsonb)`);
      }
      await writeOutbox(tx, {
        aggregate: "routing_policy",
        aggregateId: id,
        eventType: "policy.replaced",
        payload: { version: ifMatch + 1 },
      });
      await this.audit(tx, a, "routing_policy.replace", { type: "routing_policy", id }, { ...b, version: ifMatch + 1 }, null);
      const [out] = await this.listPoliciesTx(tx, id);
      return out!;
    });
  }

  private async listPoliciesTx(tx: Tx, id: string) {
    const [p] = await rows<Row & { version: number }>(
      tx,
      sql`select id, tenant_id, platform_code as platform, operation, strategy, failover_enabled, max_attempts, allow_unverified, enabled, version
      from routing_policies where id = ${id}`,
    );
    const rules = await rows(
      tx,
      sql`select r.id, r.connector_id, c.key as connector_key, r.priority, r.weight, r.enabled, r.max_share_pct
      from routing_rules r join connectors c on c.id = r.connector_id where r.policy_id = ${id} order by r.priority, r.weight desc`,
    );
    return [{ ...p, rules }];
  }

  /** Dry-run router (tanpa reservasi token/quota): snapshot DB + health tersimpan (provider_health). */
  async simulate(b: {
    tenant_id: string;
    platform: string;
    operation: Operation;
    run_kind: RouteInput["runKind"];
    interval_sec: number;
    exclude_connector_ids?: string[];
    shared_pool_only?: boolean;
  }) {
    const snap = await loadRoutingSnapshot(this.db, -1);
    const hs = await this.sys((tx) =>
      rows<{ connector_id: string; account: string; circuit: HealthState["circuit"]; score: number | null }>(
        tx,
        sql`select connector_id, provider_account_key as account, circuit, score from provider_health`,
      ),
    );
    const health = {
      get: (c: string, acc: string) =>
        hs.find((h) => h.connector_id === c && h.account === acc) ?? { circuit: "closed" as const, score: null },
    };
    const input: RouteInput = {
      tenantId: b.tenant_id,
      platform: b.platform,
      operation: b.operation,
      runKind: b.run_kind,
      requiredFeatures: ["term"],
      intervalSec: b.interval_sec,
      excludeConnectorIds: b.exclude_connector_ids ?? [],
      excludeAccountIds: [],
      estimatedUnits: { requests: 1, results: 0 },
      sharedPoolOnly: b.shared_pool_only,
    };
    const r = evaluate(snap, input, {
      health,
      reserver: { tryReserve: async () => ({ ok: false, reason: "THROTTLED", retryAfterMs: 0 }) },
    });
    const decision = (() => {
      if (!r.policy) return { kind: "none_available", reason: "NO_POLICY" };
      if (!r.policy.enabled) return { kind: "none_available", reason: "POLICY_DISABLED" };
      if (!r.candidates.length) return { kind: "none_available", reason: r.unhealthyOnly ? "ALL_UNHEALTHY" : "NO_CANDIDATE" };
      // deterministik untuk simulasi: prioritas terkecil, bobot efektif terbesar (router nyata = acak berbobot)
      const minP = Math.min(...r.candidates.map((c) => c.rule.priority));
      const best = r.candidates.filter((c) => c.rule.priority === minP).sort((x, y) => y.rule.weight - x.rule.weight)[0]!;
      return {
        kind: "selected",
        connector_key: best.connector.key,
        account_label: best.accounts[0]?.label ?? null,
        strategy: r.policy.strategy,
      };
    })();
    return {
      decision,
      trace: r.trace.map((t) => ({
        connector_key: t.connectorKey,
        priority: t.priority,
        ...(t.eliminatedBy
          ? { eliminated_by: t.eliminatedBy }
          : { effective_weight: t.effectiveWeight, eligible_accounts: t.eligibleAccounts }),
      })),
    };
  }

  // ---------- rate limits & quotas ----------
  listRateLimits() {
    return this.sys((tx) => rows(tx, sql`select * from rate_limit_policies order by scope_type, scope_id`));
  }
  async upsertRateLimit(
    a: Actor,
    id: string | null,
    b: {
      scope_type?: "provider" | "connector" | "provider_account";
      scope_id?: string;
      algorithm?: "token_bucket" | "fixed_window" | "concurrency";
      capacity?: number;
      refill_tokens?: number;
      refill_interval_ms?: number;
      source?: "provider_docs" | "provider_header" | "observed" | "internal_safety";
      source_ref?: string;
      enabled?: boolean;
    },
  ) {
    return this.sys(async (tx) => {
      let rid = id;
      if (!rid) {
        rid = Bun.randomUUIDv7();
        await tx.execute(sql`insert into rate_limit_policies (id, scope_type, scope_id, algorithm, capacity, refill_tokens, refill_interval_ms, source, source_ref, verified_at, enabled)
          values (${rid}, ${b.scope_type!}::e_scope, ${b.scope_id!}, ${b.algorithm!}::e_rl_algo, ${b.capacity!}, ${b.refill_tokens ?? 0}, ${b.refill_interval_ms ?? 1000},
                  ${b.source!}::e_fact_source, ${b.source_ref!}, ${b.source === "provider_docs" ? sql`now()` : null}, ${b.enabled ?? true})`);
      } else {
        const r = await rows(
          tx,
          sql`update rate_limit_policies set capacity = coalesce(${b.capacity ?? null}, capacity),
            refill_tokens = coalesce(${b.refill_tokens ?? null}, refill_tokens), refill_interval_ms = coalesce(${b.refill_interval_ms ?? null}, refill_interval_ms),
            source = coalesce(${b.source ?? null}::e_fact_source, source), source_ref = coalesce(${b.source_ref ?? null}, source_ref),
            enabled = coalesce(${b.enabled ?? null}, enabled) where id = ${rid} returning id`,
        );
        if (!r.length) throw new ApiError("NOT_FOUND", "Rate limit tidak ditemukan");
      }
      await writeOutbox(tx, {
        aggregate: "rate_limit_policy",
        aggregateId: rid,
        eventType: id ? "rate_limit.updated" : "rate_limit.created",
      });
      await this.audit(tx, a, id ? "rate_limit.update" : "rate_limit.create", { type: "rate_limit_policy", id: rid }, b, null);
      const [out] = await rows(tx, sql`select * from rate_limit_policies where id = ${rid}`);
      return out!;
    });
  }

  listQuotas() {
    return this.sys((tx) =>
      rows(
        tx,
        sql`select qp.*, qp.limit_value::float8 as limit_value,
                 (select u.used::float8 from quota_usage u where u.scope_type = qp.scope_type and u.scope_id = coalesce(qp.scope_id, '00000000-0000-0000-0000-000000000000')
                    and u.period = qp.period and u.unit = qp.unit order by u.period_start desc limit 1) as used
          from quota_policies qp order by scope_type, scope_id`,
      ),
    );
  }
  async upsertQuota(
    a: Actor,
    id: string | null,
    b: {
      scope_type?: "global" | "tenant" | "topic" | "provider" | "connector" | "provider_account";
      scope_id?: string | null;
      period?: "day" | "month";
      unit?: "requests" | "results" | "cost_units";
      limit_value?: number;
      hard?: boolean;
      alert_thresholds?: number[];
      reset_tz?: string;
      enabled?: boolean;
    },
  ) {
    return this.sys(async (tx) => {
      let qid = id;
      try {
        if (!qid) {
          qid = Bun.randomUUIDv7();
          await tx.execute(sql`insert into quota_policies (id, scope_type, scope_id, period, unit, limit_value, hard, alert_thresholds, reset_tz, enabled)
            values (${qid}, ${b.scope_type!}::e_quota_scope, ${b.scope_id ?? null}, ${b.period!}::e_period, ${b.unit!}::e_unit, ${b.limit_value!}, ${b.hard ?? true},
                    ${`{${(b.alert_thresholds ?? [50, 80, 95]).join(",")}}`}::smallint[], ${b.reset_tz ?? "UTC"}, ${b.enabled ?? true})`);
        } else {
          const r = await rows(
            tx,
            sql`update quota_policies set limit_value = coalesce(${b.limit_value ?? null}, limit_value), hard = coalesce(${b.hard ?? null}, hard),
              alert_thresholds = ${b.alert_thresholds ? sql`${`{${b.alert_thresholds.join(",")}}`}::smallint[]` : sql`alert_thresholds`},
              enabled = coalesce(${b.enabled ?? null}, enabled) where id = ${qid} returning id`,
          );
          if (!r.length) throw new ApiError("NOT_FOUND", "Quota tidak ditemukan");
        }
      } catch (e) {
        if (pgCode(e) === "23514")
          throw new ApiError("VALIDATION_FAILED", "scope_id wajib kecuali scope global", [{ path: "scope_id", issue: "tidak konsisten" }]);
        throw e;
      }
      await writeOutbox(tx, { aggregate: "quota_policy", aggregateId: qid, eventType: id ? "quota.updated" : "quota.created" });
      await this.audit(tx, a, id ? "quota.update" : "quota.create", { type: "quota_policy", id: qid }, b, null);
      const [out] = await rows(tx, sql`select *, limit_value::float8 as limit_value from quota_policies where id = ${qid}`);
      return out!;
    });
  }

  // ---------- usage & audit ----------
  usage(q: { group_by: "connector" | "account" | "tenant"; from: string; to: string }) {
    return this.sys((tx) => {
      const range = sql`a.started_at >= ${q.from}::timestamptz and a.started_at < ${q.to}::timestamptz`;
      const sums = sql`count(*)::int as attempts,
        coalesce(sum((a.usage->>'requests')::numeric), 0)::float8 as requests,
        coalesce(sum((a.usage->>'results')::numeric), 0)::float8 as results,
        coalesce(sum((a.usage->>'costUnits')::numeric), 0)::float8 as cost_units,
        count(*) filter (where a.outcome = 'success')::int as successes`;
      if (q.group_by === "connector")
        return rows(
          tx,
          sql`select c.key as connector, ${sums} from provider_attempts a join connectors c on c.id = a.connector_id where ${range} group by c.key order by cost_units desc`,
        );
      if (q.group_by === "account")
        return rows(
          tx,
          sql`select pa.label as account, p.key as provider, ${sums} from provider_attempts a join provider_accounts pa on pa.id = a.provider_account_id
          join providers p on p.id = pa.provider_id where ${range} group by pa.label, p.key order by cost_units desc`,
        );
      // tenant: run plan (tenant_id langsung) + porsi run stream (cost_allocations, I-25)
      return rows(
        tx,
        sql`select tenant_id, sum(requests)::float8 as requests, sum(results)::float8 as results, sum(cost_units)::float8 as cost_units from (
            select a.tenant_id, (a.usage->>'requests')::numeric as requests, (a.usage->>'results')::numeric as results, coalesce((a.usage->>'costUnits')::numeric, 0) as cost_units
            from provider_attempts a where ${range} and a.tenant_id is not null
            union all
            select ca.tenant_id, ca.requests, ca.results, ca.cost_units from cost_allocations ca
            where ca.run_scheduled_for >= ${q.from}::timestamptz and ca.run_scheduled_for < ${q.to}::timestamptz) x
          group by tenant_id order by cost_units desc`,
      );
    });
  }

  auditLogs(q: { target_type?: string; actor?: string; from?: string; to?: string; limit: number }) {
    return this.sys((tx) =>
      rows(
        tx,
        sql`select id, tenant_id, actor_type, actor_id, action, target_type, target_id, after, ip, request_id, at from audit_logs where true
          ${q.target_type ? sql`and target_type = ${q.target_type}` : sql``} ${q.actor ? sql`and actor_id = ${q.actor}` : sql``}
          ${q.from ? sql`and at >= ${q.from}::timestamptz` : sql``} ${q.to ? sql`and at < ${q.to}::timestamptz` : sql``}
          order by at desc limit ${q.limit}`,
      ),
    );
  }

  // ---------- DLQ ----------
  private dlq() {
    if (!this.o.dlq) throw new ApiError("UNAVAILABLE", "DLQ tidak tersedia (queue tidak terhubung)");
    return this.o.dlq;
  }
  listDlq(queue: QueueName) {
    return this.dlq().listDlq(queue, 100);
  }
  async redriveDlq(a: Actor, queue: QueueName, jobId: string) {
    const newId = await this.dlq()
      .redrive(queue, jobId)
      .catch((e: Error) => {
        if (/tidak ditemukan/.test(e.message)) throw new ApiError("NOT_FOUND", "Job DLQ tidak ditemukan");
        throw e;
      });
    await this.sys((tx) => this.audit(tx, a, "dlq.redrive", { type: "job", id: jobId }, { queue, new_job_id: newId }, null));
    return { job_id: newId };
  }
  async discardDlq(a: Actor, queue: QueueName, jobId: string) {
    await this.dlq().discard(queue, jobId);
    await this.sys((tx) => this.audit(tx, a, "dlq.discard", { type: "job", id: jobId }, { queue }, null));
  }
}
