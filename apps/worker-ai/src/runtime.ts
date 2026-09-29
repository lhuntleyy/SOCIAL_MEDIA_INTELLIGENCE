// Runtime LLM worker-ai: pengaturan dari DB (panel "Pengaturan AI", A-03) di-cache singkat; API key didekripsi di memori;
// rotasi key round-robin, cooldown saat 429, key salah → invalid; batas RPM per provider dari `params.max_rpm` (DB, bukan kode);
// gagal semua key → model cadangan tugas. Tidak ada angka kuota provider di kode (Golden Rule 1).
import { ConnectorError, type HttpClient } from "@smip/connector-sdk";
import { credentialAad, type KmsAdapter, open } from "@smip/crypto";
import { type Db, withSystem } from "@smip/db";
import { generateJson, type JsonCall, type JsonResult, type LlmKind } from "@smip/llm";
import type { Logger } from "@smip/observability";
import { sql } from "drizzle-orm";

type Task = "default" | "sentiment" | "emotion" | "keyphrase" | "summary";
interface ProviderRow {
  id: string;
  key: string;
  kind: LlmKind;
  base_url: string | null;
  enabled: boolean;
}
interface KeyRow {
  id: string;
  provider_id: string;
  apiKey: string;
  cooldownUntil: number;
}
interface TaskRow {
  task: Task;
  provider_id: string | null;
  model_id: string | null;
  fallback_provider_id: string | null;
  fallback_model_id: string | null;
  enabled: boolean;
  params: { batch_size?: number; max_output_tokens?: number; max_rpm?: number };
}
interface Snapshot {
  at: number;
  providers: Map<string, ProviderRow>;
  keys: KeyRow[];
  tasks: Map<Task, TaskRow>;
}

export interface Resolved {
  providerKey: string;
  model: string;
  params: TaskRow["params"];
}
export interface LlmCallResult extends JsonResult {
  providerKey: string;
}

export class LlmRuntime {
  private snap: Snapshot | null = null;
  private rr = new Map<string, number>();
  private window = new Map<string, number[]>();
  constructor(
    private readonly d: {
      db: Db;
      kms: KmsAdapter;
      http?: HttpClient;
      logger?: Logger;
      ttlMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}
  private now() {
    return (this.d.now ?? Date.now)();
  }

  async load(force = false): Promise<Snapshot> {
    if (!force && this.snap && this.now() - this.snap.at < (this.d.ttlMs ?? 30_000)) return this.snap;
    const snap = await withSystem(this.d.db, async (tx) => {
      const providers = (await tx.execute(sql`select id, key, kind, base_url, enabled from llm_providers`)) as unknown as ProviderRow[];
      const keys =
        (await tx.execute(sql`select k.id, k.provider_id, k.cooldown_until, c.id as cid, c.tenant_id, c.ciphertext, c.iv, c.wrapped_dek, c.kek_id, c.aad
        from llm_api_keys k join credentials c on c.id = k.credential_id where k.status = 'active' and c.wrapped_dek is not null
        order by k.created_at`)) as unknown as {
          id: string;
          provider_id: string;
          cooldown_until: Date | null;
          cid: string;
          tenant_id: string | null;
          ciphertext: Uint8Array;
          iv: Uint8Array;
          wrapped_dek: Uint8Array;
          kek_id: string;
          aad: string;
        }[];
      const tasks = (await tx.execute(
        sql`select task, provider_id, model_id, fallback_provider_id, fallback_model_id, enabled, params from llm_task_settings`,
      )) as unknown as TaskRow[];
      const opened: KeyRow[] = [];
      for (const k of keys) {
        try {
          const s = await open<Record<string, string>>(
            this.d.kms,
            {
              ciphertext: new Uint8Array(k.ciphertext),
              iv: new Uint8Array(k.iv),
              wrapped_dek: new Uint8Array(k.wrapped_dek),
              kek_id: k.kek_id,
              aad: k.aad,
            },
            credentialAad(k.cid, k.tenant_id),
          );
          opened.push({
            id: k.id,
            provider_id: k.provider_id,
            apiKey: s.api_key ?? "",
            cooldownUntil: k.cooldown_until ? new Date(k.cooldown_until).getTime() : 0,
          });
        } catch {
          this.d.logger?.warn("API key LLM tidak dapat didekripsi — dilewati", { key_id: k.id });
        }
      }
      return {
        at: this.now(),
        providers: new Map(providers.map((p) => [p.id, p])),
        keys: opened,
        tasks: new Map(tasks.map((t) => [t.task, t])),
      };
    });
    this.snap = snap;
    return snap;
  }

  /** Pengaturan efektif tugas (tugas sendiri → `default`); null = LLM tidak dikonfigurasi/aktif. */
  async resolve(task: Task): Promise<{
    primary: { provider: ProviderRow; model: string } | null;
    fallback: { provider: ProviderRow; model: string } | null;
    params: TaskRow["params"];
  } | null> {
    const s = await this.load();
    const t = s.tasks.get(task)?.enabled ? s.tasks.get(task) : s.tasks.get("default")?.enabled ? s.tasks.get("default") : undefined;
    if (!t) return null;
    const pick = (pid: string | null, model: string | null) => {
      const p = pid ? s.providers.get(pid) : undefined;
      return p?.enabled && model ? { provider: p, model } : null;
    };
    const primary = pick(t.provider_id, t.model_id);
    const fallback = pick(t.fallback_provider_id, t.fallback_model_id);
    if (!primary && !fallback) return null;
    return { primary, fallback, params: t.params ?? {} };
  }

  /** Batas RPM (sliding window 60 s) per provider — nilai dari params tugas (DB). */
  private async throttle(providerId: string, maxRpm?: number) {
    if (!maxRpm) return;
    const w = (this.window.get(providerId) ?? []).filter((t) => this.now() - t < 60_000);
    if (w.length >= maxRpm) {
      const wait = 60_000 - (this.now() - w[0]!) + 50;
      await (this.d.sleep ?? ((ms) => Bun.sleep(ms)))(wait);
    }
    this.window.set(providerId, [...w.filter((t) => this.now() - t < 60_000), this.now()]);
  }

  private async mark(keyId: string, err?: ConnectorError) {
    const k = this.snap?.keys.find((x) => x.id === keyId);
    if (err?.code === "RATE_LIMITED" && k) k.cooldownUntil = this.now() + 60_000;
    if (err?.code === "AUTH_INVALID" && this.snap) this.snap.keys = this.snap.keys.filter((x) => x.id !== keyId);
    await withSystem(this.d.db, (tx) =>
      tx.execute(sql`update llm_api_keys set last_used_at = now(), requests_total = requests_total + 1, last_error_code = ${err?.code ?? null},
          status = case when ${err?.code ?? null} = 'AUTH_INVALID' then 'invalid' else status end,
          cooldown_until = case when ${err?.code ?? null} = 'RATE_LIMITED' then now() + interval '60 seconds' else cooldown_until end
        where id = ${keyId}`),
    ).catch((e) => this.d.logger?.warn("gagal menandai API key LLM", { error: e }));
  }

  /** Coba semua key aktif provider bergiliran; RATE_LIMITED/AUTH_INVALID → key berikutnya. */
  private async withKeys(provider: ProviderRow, model: string, call: JsonCall, maxRpm?: number): Promise<LlmCallResult> {
    const s = await this.load();
    const keys = s.keys.filter((k) => k.provider_id === provider.id && k.cooldownUntil < this.now());
    if (!keys.length) throw new ConnectorError("QUOTA_EXHAUSTED", `provider ${provider.key}: tidak ada API key aktif (semua jeda/invalid)`);
    const start = this.rr.get(provider.id) ?? 0;
    let last: ConnectorError | null = null;
    for (let n = 0; n < keys.length; n++) {
      const k = keys[(start + n) % keys.length]!;
      this.rr.set(provider.id, (start + n + 1) % keys.length);
      await this.throttle(provider.id, maxRpm);
      try {
        const r = await generateJson(provider, k.apiKey, model, call, this.d.http);
        await this.mark(k.id);
        return { ...r, providerKey: provider.key };
      } catch (e) {
        const err = e instanceof ConnectorError ? e : new ConnectorError("PARSE_ERROR", (e as Error).message);
        await this.mark(k.id, err);
        last = err;
        if (err.code !== "RATE_LIMITED" && err.code !== "AUTH_INVALID") throw err; // error lain: jangan habiskan key lain
      }
    }
    throw last ?? new ConnectorError("UNKNOWN", "semua key gagal");
  }

  /** Panggil model utama tugas; gagal → model cadangan (bila diatur). */
  async call(task: Task, build: (maxOutputTokens: number) => JsonCall): Promise<LlmCallResult & { resolved: Resolved }> {
    const r = await this.resolve(task);
    if (!r) throw new ConnectorError("NOT_SUPPORTED", `LLM untuk tugas ${task} belum diatur/aktif`);
    const c = build(r.params.max_output_tokens ?? 4096);
    let firstErr: unknown = null;
    for (const t of [r.primary, r.fallback]) {
      if (!t) continue;
      try {
        const out = await this.withKeys(t.provider, t.model, c, r.params.max_rpm);
        return { ...out, resolved: { providerKey: t.provider.key, model: t.model, params: r.params } };
      } catch (e) {
        firstErr ??= e;
        this.d.logger?.warn("panggilan LLM gagal", { task, provider: t.provider.key, model: t.model, code: (e as ConnectorError).code });
      }
    }
    throw firstErr;
  }
}
