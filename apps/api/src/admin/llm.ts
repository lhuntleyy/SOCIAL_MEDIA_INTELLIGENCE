// Pengaturan LLM (Fase 3, A-03) dari panel admin: provider (protokol gemini / openai_compatible / anthropic), BANYAK API key
// per provider (rotasi + cooldown), katalog model dari API provider, pemetaan tugas NLP → provider/model (+ cadangan).
// Operator platform saja. API key write-only (SEC-02): disegel di `credentials`, respons hanya `display_hint`.
import type { HttpClient } from "@smip/connector-sdk";
import { ConnectorError } from "@smip/connector-sdk";
import { auditLogs, type Db, type Tx, withSystem, writeOutbox } from "@smip/db";
import { sql } from "drizzle-orm";
import { ApiError } from "../errors";
import { generateJson, type LlmKind, listModels, SENTIMENT_SCHEMA, SENTIMENT_SYSTEM } from "@smip/llm";
import { openCredential, type SealDeps, sealCredential } from "./credentials";
import type { Actor } from "./service";

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as T[];
export const LLM_TASKS = ["default", "sentiment", "emotion", "keyphrase", "summary"] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export interface LlmAdminOptions extends SealDeps {
  http?: HttpClient;
  now?: () => Date;
}

export class LlmAdminService {
  constructor(
    private readonly db: Db,
    private readonly o: LlmAdminOptions,
  ) {}
  private sys<T>(fn: (tx: Tx) => Promise<T>) {
    return withSystem(this.db, fn);
  }
  private async audit(tx: Tx, a: Actor, action: string, id: string, after?: unknown) {
    await tx.insert(auditLogs).values({
      id: Bun.randomUUIDv7(),
      tenantId: null,
      actorType: "user",
      actorId: a.userId,
      action,
      targetType: "llm",
      targetId: id,
      after: after ?? null,
      ip: a.ip ?? null,
      userAgent: a.ua ?? null,
      requestId: a.requestId ?? null,
    });
  }
  /** Perubahan pengaturan → outbox (worker-ai memuat ulang cache pengaturan). */
  private changed(tx: Tx, id: string, event: string, payload?: Record<string, unknown>) {
    return writeOutbox(tx, { aggregate: "llm_settings", aggregateId: id, eventType: event, ...(payload ? { payload } : {}) });
  }
  private async assertSafeBase(url: string | null | undefined) {
    if (!url || !this.o.http) return;
    try {
      await this.o.http.assertSafeUrl(url);
    } catch (e) {
      throw new ApiError("VALIDATION_FAILED", "base_url ditolak (SSRF guard: wajib https, bukan IP privat)", [
        { path: "base_url", issue: (e as Error).message },
      ]);
    }
  }

  // ---------- baca ----------
  overview() {
    return this.sys(async (tx) => {
      const providers = await rows(
        tx,
        sql`select p.id, p.key, p.name, p.kind, p.base_url, p.enabled, p.created_at,
                 (select count(*)::int from llm_models m where m.provider_id = p.id) as models,
                 (select max(fetched_at) from llm_models m where m.provider_id = p.id) as models_fetched_at
          from llm_providers p order by p.name`,
      );
      const keys = await rows(
        tx,
        sql`select id, provider_id, label, display_hint, status, cooldown_until, last_error_code, last_used_at, requests_total, created_at
          from llm_api_keys where status <> 'revoked' order by created_at`,
      );
      const tasks = await rows(
        tx,
        sql`select task, provider_id, model_id, fallback_provider_id, fallback_model_id, enabled, params, version, updated_at from llm_task_settings`,
      );
      return {
        providers: providers.map((p) => ({ ...p, keys: keys.filter((k) => k.provider_id === p.id).map(({ provider_id: _p, ...k }) => k) })),
        tasks: LLM_TASKS.map(
          (t) => tasks.find((x) => x.task === t) ?? { task: t, provider_id: null, model_id: null, enabled: false, params: {}, version: 0 },
        ),
      };
    });
  }

  models(providerId: string) {
    return this.sys((tx) =>
      rows(
        tx,
        sql`select model_id, display_name, input_token_limit, output_token_limit, fetched_at from llm_models where provider_id = ${providerId} order by model_id`,
      ),
    );
  }

  // ---------- provider ----------
  async createProvider(
    a: Actor,
    b: { key: string; name: string; kind: LlmKind; base_url?: string | null; api_key?: string; key_label?: string },
  ) {
    await this.assertSafeBase(b.base_url);
    const created = await this.sys(async (tx) => {
      const id = Bun.randomUUIDv7();
      try {
        await tx.execute(
          sql`insert into llm_providers (id, key, name, kind, base_url) values (${id}, ${b.key}, ${b.name}, ${b.kind}, ${b.base_url ?? null})`,
        );
      } catch (e) {
        const msg = String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? "");
        if (/llm_providers_key_key|duplicate/.test(msg)) throw new ApiError("CONFLICT", "Key provider sudah dipakai");
        if (/check/i.test(msg))
          throw new ApiError("VALIDATION_FAILED", "base_url wajib untuk openai_compatible", [{ path: "base_url", issue: "wajib" }]);
        throw e;
      }
      if (b.api_key) await this.insertKey(tx, id, b.key_label ?? "utama", b.api_key);
      await this.changed(tx, id, "llm.provider_created");
      await this.audit(tx, a, "llm.provider.create", id, { key: b.key, kind: b.kind, base_url: b.base_url ?? null, with_key: !!b.api_key });
      return id;
    });
    return created;
  }

  async patchProvider(a: Actor, id: string, b: { name?: string; base_url?: string | null; enabled?: boolean }) {
    if (b.base_url !== undefined) await this.assertSafeBase(b.base_url);
    return this.sys(async (tx) => {
      const r = await rows(
        tx,
        sql`update llm_providers set name = coalesce(${b.name ?? null}, name),
            base_url = ${b.base_url === undefined ? sql`base_url` : b.base_url}, enabled = coalesce(${b.enabled ?? null}, enabled), updated_at = now()
          where id = ${id} returning id`,
      );
      if (!r.length) throw new ApiError("NOT_FOUND", "Provider LLM tidak ditemukan");
      await this.changed(tx, id, "llm.provider_updated");
      await this.audit(tx, a, "llm.provider.update", id, b);
    });
  }

  async deleteProvider(a: Actor, id: string) {
    await this.sys(async (tx) => {
      const creds = await rows<{ credential_id: string }>(tx, sql`select credential_id from llm_api_keys where provider_id = ${id}`);
      const r = await rows(tx, sql`delete from llm_providers where id = ${id} returning id`);
      if (!r.length) throw new ApiError("NOT_FOUND", "Provider LLM tidak ditemukan");
      for (const c of creds) await tx.execute(sql`update credentials set wrapped_dek = null where id = ${c.credential_id}`); // crypto-shred
      await this.changed(tx, id, "llm.provider_deleted");
      await this.audit(tx, a, "llm.provider.delete", id);
    });
  }

  // ---------- API key (banyak per provider) ----------
  private async insertKey(tx: Tx, providerId: string, label: string, apiKey: string) {
    const cred = await sealCredential(this.o, tx, null, "api_key", { api_key: apiKey });
    const id = Bun.randomUUIDv7();
    try {
      await tx.execute(
        sql`insert into llm_api_keys (id, provider_id, label, credential_id, display_hint) values (${id}, ${providerId}, ${label}, ${cred.id}, ${cred.hint})`,
      );
    } catch (e) {
      if (
        /llm_api_keys_provider_id_label_key|duplicate/.test(
          String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? ""),
        )
      )
        throw new ApiError("CONFLICT", "Label key sudah dipakai di provider ini");
      throw e;
    }
    return { id, label, display_hint: cred.hint };
  }

  async addKey(a: Actor, providerId: string, b: { label: string; api_key: string }) {
    return this.sys(async (tx) => {
      const [p] = await rows(tx, sql`select id from llm_providers where id = ${providerId}`);
      if (!p) throw new ApiError("NOT_FOUND", "Provider LLM tidak ditemukan");
      const k = await this.insertKey(tx, providerId, b.label, b.api_key);
      await this.changed(tx, providerId, "llm.key_added");
      await this.audit(tx, a, "llm.key.add", k.id, { provider_id: providerId, label: b.label });
      return k;
    });
  }

  async patchKey(a: Actor, keyId: string, b: { status?: "active" | "disabled"; label?: string }) {
    return this.sys(async (tx) => {
      const r = await rows(
        tx,
        sql`update llm_api_keys set status = coalesce(${b.status ?? null}, status), label = coalesce(${b.label ?? null}, label),
            cooldown_until = case when ${b.status ?? null} = 'active' then null else cooldown_until end,
            last_error_code = case when ${b.status ?? null} = 'active' then null else last_error_code end
          where id = ${keyId} and status <> 'revoked' returning provider_id`,
      );
      if (!r.length) throw new ApiError("NOT_FOUND", "API key tidak ditemukan");
      await this.changed(tx, String(r[0]!.provider_id), "llm.key_updated");
      await this.audit(tx, a, "llm.key.update", keyId, b);
    });
  }

  async revokeKey(a: Actor, keyId: string) {
    await this.sys(async (tx) => {
      const r = await rows<{ credential_id: string; provider_id: string }>(
        tx,
        sql`update llm_api_keys set status = 'revoked' where id = ${keyId} and status <> 'revoked' returning credential_id, provider_id`,
      );
      if (!r.length) throw new ApiError("NOT_FOUND", "API key tidak ditemukan");
      await tx.execute(sql`update credentials set wrapped_dek = null where id = ${r[0]!.credential_id}`);
      await this.changed(tx, r[0]!.provider_id, "llm.key_revoked");
      await this.audit(tx, a, "llm.key.revoke", keyId);
    });
  }

  /** Key aktif pertama yang tidak cooldown (untuk refresh model / tes). */
  private async pickKey(tx: Tx, providerId: string) {
    const [p] = await rows<{ kind: LlmKind; base_url: string | null; enabled: boolean }>(
      tx,
      sql`select kind, base_url, enabled from llm_providers where id = ${providerId}`,
    );
    if (!p) throw new ApiError("NOT_FOUND", "Provider LLM tidak ditemukan");
    const [k] = await rows<{ id: string; credential_id: string }>(
      tx,
      sql`select id, credential_id from llm_api_keys where provider_id = ${providerId} and status = 'active'
          and (cooldown_until is null or cooldown_until < now()) order by last_used_at nulls first limit 1`,
    );
    if (!k) throw new ApiError("CONFLICT", "Provider belum punya API key aktif");
    const secret = await openCredential(this.o, tx, k.credential_id);
    return { provider: p, keyId: k.id, apiKey: secret.api_key ?? "" };
  }

  private async markKey(tx: Tx, keyId: string, err?: ConnectorError) {
    if (!err) {
      await tx.execute(
        sql`update llm_api_keys set last_used_at = now(), requests_total = requests_total + 1, last_error_code = null where id = ${keyId}`,
      );
      return;
    }
    // 401/403 → key tidak valid (manual); 429 → cooldown 60 s
    await tx.execute(sql`update llm_api_keys set last_used_at = now(), requests_total = requests_total + 1, last_error_code = ${err.code},
        status = case when ${err.code} = 'AUTH_INVALID' then 'invalid' else status end,
        cooldown_until = case when ${err.code} = 'RATE_LIMITED' then now() + interval '60 seconds' else cooldown_until end
      where id = ${keyId}`);
  }

  async refreshModels(a: Actor, providerId: string) {
    return this.sys(async (tx) => {
      const { provider, keyId, apiKey } = await this.pickKey(tx, providerId);
      let list: Awaited<ReturnType<typeof listModels>>;
      try {
        list = await listModels(provider, apiKey, this.o.http);
      } catch (e) {
        const err = e instanceof ConnectorError ? e : new ConnectorError("UNKNOWN", String((e as Error).message));
        await this.markKey(tx, keyId, err);
        throw new ApiError("UNAVAILABLE", `Gagal mengambil daftar model: ${err.message}`);
      }
      await this.markKey(tx, keyId);
      await tx.execute(sql`delete from llm_models where provider_id = ${providerId}`);
      for (const m of list)
        await tx.execute(sql`insert into llm_models (provider_id, model_id, display_name, input_token_limit, output_token_limit)
          values (${providerId}, ${m.model_id}, ${m.display_name}, ${m.input_token_limit}, ${m.output_token_limit})`);
      await this.audit(tx, a, "llm.models.refresh", providerId, { count: list.length });
      return { count: list.length };
    });
  }

  /** Tes model dengan teks sintetis (atau teks operator) — bukan data post. */
  async test(a: Actor, b: { provider_id: string; model_id: string; text?: string; topic?: string }) {
    return this.sys(async (tx) => {
      const { provider, keyId, apiKey } = await this.pickKey(tx, b.provider_id);
      try {
        const r = await generateJson(
          provider,
          apiKey,
          b.model_id,
          {
            system: SENTIMENT_SYSTEM,
            user: `Topik: ${b.topic ?? "koperasi desa"}\nPost: ${b.text ?? "hebat banget, 3 bulan gaji pengurus belum cair 👏"}`,
            schema: SENTIMENT_SCHEMA,
            maxOutputTokens: 256,
          },
          this.o.http,
        );
        await this.markKey(tx, keyId);
        await this.audit(tx, a, "llm.test", b.provider_id, { model_id: b.model_id, ok: true, latency_ms: r.latencyMs });
        return {
          ok: true,
          result: r.json,
          latency_ms: r.latencyMs,
          input_tokens: r.inputTokens,
          output_tokens: r.outputTokens,
          model: r.model,
        };
      } catch (e) {
        const err = e instanceof ConnectorError ? e : new ConnectorError("PARSE_ERROR", String((e as Error).message));
        await this.markKey(tx, keyId, err);
        await this.audit(tx, a, "llm.test", b.provider_id, { model_id: b.model_id, ok: false, code: err.code });
        return { ok: false, error: { code: err.code, message: err.message } };
      }
    });
  }

  // ---------- tugas → model ----------
  async putTask(
    a: Actor,
    task: LlmTask,
    b: {
      provider_id: string | null;
      model_id: string | null;
      fallback_provider_id?: string | null;
      fallback_model_id?: string | null;
      enabled: boolean;
      params?: Record<string, unknown>;
    },
  ) {
    return this.sys(async (tx) => {
      for (const [pid, mid, path] of [
        [b.provider_id, b.model_id, "model_id"],
        [b.fallback_provider_id ?? null, b.fallback_model_id ?? null, "fallback_model_id"],
      ] as const) {
        if (!pid) continue;
        const [m] = await rows(tx, sql`select 1 from llm_models where provider_id = ${pid} and model_id = ${mid}`);
        if (!m)
          throw new ApiError("VALIDATION_FAILED", "Model tidak ada di katalog provider (klik Refresh model dulu)", [
            { path, issue: String(mid) },
          ]);
      }
      await tx.execute(sql`insert into llm_task_settings (task, provider_id, model_id, fallback_provider_id, fallback_model_id, enabled, params, updated_by)
        values (${task}, ${b.provider_id}, ${b.model_id}, ${b.fallback_provider_id ?? null}, ${b.fallback_model_id ?? null}, ${b.enabled},
                ${JSON.stringify(b.params ?? {})}::text::jsonb, ${a.userId})
        on conflict (task) do update set provider_id = excluded.provider_id, model_id = excluded.model_id,
          fallback_provider_id = excluded.fallback_provider_id, fallback_model_id = excluded.fallback_model_id, enabled = excluded.enabled,
          params = excluded.params, updated_by = excluded.updated_by, updated_at = now(), version = llm_task_settings.version + 1`);
      // outbox.aggregate_id bertipe uuid → tugas dikirim di payload
      await this.changed(tx, "00000000-0000-0000-0000-000000000000", "llm.task_updated", { task });
      await this.audit(tx, a, "llm.task.update", task, b);
    });
  }
}
