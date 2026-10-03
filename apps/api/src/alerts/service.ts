// O-05 Alerts (API_SPEC §8): aturan alert per topik, riwayat event (ack/resolve), saluran notifikasi kantor (Telegram/webhook;
// secret write-only, disegel di credentials). Semua query difilter tenant eksplisit (withSystem) + audit.
import type { HttpClient } from "@smip/connector-sdk";
import { auditLogs, type Db, type Tx, withSystem } from "@smip/db";
import { type AlertMessage, type ChannelTarget, deliver } from "@smip/notify";
import { sql } from "drizzle-orm";
import { openCredential, type SealDeps, sealCredential } from "../admin/credentials";
import { ApiError } from "../errors";
import type { Actor } from "../topics/service";

export type AlertType = "negative_ratio" | "volume_spike" | "new_issue";
export interface RuleBody {
  topic_id: string;
  type: AlertType;
  params: Record<string, number>;
  channels?: string[];
  cooldown_sec?: number;
  enabled?: boolean;
}
export interface ChannelBody {
  kind: "telegram" | "webhook";
  name: string;
  config: { chat_id?: string; url?: string };
  /** telegram: token bot (wajib); webhook: kunci tanda tangan HMAC (opsional) */
  secret?: string;
  enabled?: boolean;
}

const rows = async <T>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as T[];

export class AlertService {
  constructor(
    private readonly db: Db,
    private readonly o: SealDeps & { http?: HttpClient },
  ) {}

  private audit(tx: Tx, a: Actor, action: string, targetId: string, after?: Record<string, unknown>) {
    return tx.insert(auditLogs).values({
      id: Bun.randomUUIDv7(),
      tenantId: a.tenantId,
      actorType: "user",
      actorId: a.userId,
      action,
      targetType: "alert",
      targetId,
      after: after ?? null,
      ip: a.ip ?? null,
      userAgent: a.ua ?? null,
      requestId: a.requestId ?? null,
    });
  }

  private async assertTopic(tx: Tx, a: Actor, topicId: string) {
    const [t] = await rows(tx, sql`select 1 from topics where id = ${topicId} and tenant_id = ${a.tenantId} and deleted_at is null`);
    if (!t) throw new ApiError("VALIDATION_FAILED", "Topik tidak ditemukan", [{ path: "topic_id", issue: "tidak ada" }]);
  }
  private async assertChannels(tx: Tx, a: Actor, ids: string[] | undefined) {
    if (!ids?.length) return;
    const ok = await rows<{ id: string }>(
      tx,
      sql`select id from notification_channels where tenant_id = ${a.tenantId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
    );
    if (ok.length !== new Set(ids).size)
      throw new ApiError("VALIDATION_FAILED", "Saluran tidak dikenal", [{ path: "channels", issue: "tidak ada" }]);
  }

  // ---------- aturan ----------
  listRules(a: Actor) {
    return withSystem(this.db, (tx) =>
      rows(
        tx,
        sql`select r.id, r.topic_id, t.name as topic_name, r.type, r.params, to_jsonb(r.channels) as channels, r.cooldown_sec, r.enabled, r.created_at,
                   (select max(e.fired_at) from alert_events e where e.rule_id = r.id) as last_fired_at
            from alert_rules r join topics t on t.id = r.topic_id
            where r.tenant_id = ${a.tenantId} and t.deleted_at is null order by t.name, r.created_at`,
      ),
    );
  }

  createRule(a: Actor, b: RuleBody) {
    return withSystem(this.db, async (tx) => {
      await this.assertTopic(tx, a, b.topic_id);
      await this.assertChannels(tx, a, b.channels);
      const id = Bun.randomUUIDv7();
      await tx.execute(sql`insert into alert_rules (id, tenant_id, topic_id, type, params, channels, cooldown_sec, enabled, created_by)
        values (${id}, ${a.tenantId}, ${b.topic_id}, ${b.type}::e_alert_type, ${JSON.stringify(b.params)}::text::jsonb,
                ${`{${(b.channels ?? []).join(",")}}`}::uuid[], ${b.cooldown_sec ?? 3600}, ${b.enabled ?? true}, ${a.userId})`);
      await this.audit(tx, a, "alert_rule.create", id, { type: b.type, topic_id: b.topic_id });
      return { id };
    });
  }

  updateRule(a: Actor, id: string, b: Partial<Omit<RuleBody, "topic_id" | "type">>) {
    return withSystem(this.db, async (tx) => {
      await this.assertChannels(tx, a, b.channels);
      const r = await rows(
        tx,
        sql`update alert_rules set
              params = coalesce(${b.params ? JSON.stringify(b.params) : null}::text::jsonb, params),
              channels = coalesce(${b.channels ? `{${b.channels.join(",")}}` : null}::uuid[], channels),
              cooldown_sec = coalesce(${b.cooldown_sec ?? null}::int, cooldown_sec),
              enabled = coalesce(${b.enabled ?? null}::boolean, enabled)
            where id = ${id} and tenant_id = ${a.tenantId} returning id`,
      );
      if (!r.length) throw new ApiError("NOT_FOUND", "Aturan tidak ditemukan");
      await this.audit(tx, a, "alert_rule.update", id, { fields: Object.keys(b) });
      return { id };
    });
  }

  deleteRule(a: Actor, id: string) {
    return withSystem(this.db, async (tx) => {
      const r = await rows(tx, sql`delete from alert_rules where id = ${id} and tenant_id = ${a.tenantId} returning id`);
      if (!r.length) throw new ApiError("NOT_FOUND", "Aturan tidak ditemukan");
      await this.audit(tx, a, "alert_rule.delete", id);
    });
  }

  // ---------- event ----------
  listEvents(a: Actor, q: { status?: "open" | "acked" | "resolved"; limit: number }) {
    return withSystem(this.db, async (tx) => {
      const items = await rows(
        tx,
        sql`select e.id, e.rule_id, r.type, r.topic_id, t.name as topic_name, e.fired_at, e.status, e.payload, e.resolved_at,
                   u.name as acked_by_name
            from alert_events e join alert_rules r on r.id = e.rule_id join topics t on t.id = r.topic_id
            left join users u on u.id = e.acked_by
            where e.tenant_id = ${a.tenantId} ${q.status ? sql`and e.status = ${q.status}::e_alert_status` : sql``}
            order by e.fired_at desc limit ${q.limit}`,
      );
      const [c] = await rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from alert_events where tenant_id = ${a.tenantId} and status = 'open'`,
      );
      return { items, open: c?.n ?? 0 };
    });
  }

  setEventStatus(a: Actor, id: string, status: "acked" | "resolved") {
    return withSystem(this.db, async (tx) => {
      const r = await rows(
        tx,
        sql`update alert_events set status = ${status}::e_alert_status,
              acked_by = coalesce(acked_by, ${a.userId}::uuid),
              resolved_at = ${status === "resolved" ? sql`now()` : sql`resolved_at`}
            where id = ${id} and tenant_id = ${a.tenantId} and status <> 'resolved' returning id, status`,
      );
      if (!r.length) throw new ApiError("NOT_FOUND", "Alert tidak ditemukan / sudah selesai");
      await this.audit(tx, a, `alert_event.${status === "acked" ? "ack" : "resolve"}`, id);
      return r[0]!;
    });
  }

  // ---------- saluran ----------
  listChannels(a: Actor) {
    return withSystem(this.db, async (tx) =>
      (
        await rows<{ id: string; kind: string; config: Record<string, unknown>; credential_id: string | null; enabled: boolean }>(
          tx,
          sql`select id, kind, config, credential_id, enabled from notification_channels where tenant_id = ${a.tenantId} order by config->>'name'`,
        )
      ).map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.config.name ?? c.kind,
        config: c.config,
        has_secret: !!c.credential_id,
        enabled: c.enabled,
      })),
    );
  }

  private async validateChannel(b: Pick<ChannelBody, "kind" | "config" | "secret">, creating: boolean) {
    if (b.kind === "telegram") {
      if (!b.config.chat_id || !/^-?\d{1,20}$|^@[A-Za-z0-9_]{5,64}$/.test(b.config.chat_id))
        throw new ApiError("VALIDATION_FAILED", "chat_id Telegram tidak valid", [{ path: "config.chat_id", issue: "angka atau @kanal" }]);
      if (creating && !b.secret) throw new ApiError("VALIDATION_FAILED", "Token bot wajib diisi", [{ path: "secret", issue: "wajib" }]);
      if (b.secret && !/^\d{5,15}:[A-Za-z0-9_-]{20,100}$/.test(b.secret))
        throw new ApiError("VALIDATION_FAILED", "Format token bot tidak valid", [{ path: "secret", issue: "123456:ABC…" }]);
    } else {
      if (!b.config.url) throw new ApiError("VALIDATION_FAILED", "URL webhook wajib", [{ path: "config.url", issue: "wajib" }]);
      try {
        if (this.o.http) await this.o.http.assertSafeUrl(b.config.url);
        else if (!b.config.url.startsWith("https://")) throw new Error("wajib https");
      } catch (e) {
        throw new ApiError("VALIDATION_FAILED", "URL webhook ditolak (wajib https, bukan alamat privat)", [
          { path: "config.url", issue: (e as Error).message },
        ]);
      }
    }
  }

  async createChannel(a: Actor, b: ChannelBody) {
    await this.validateChannel(b, true);
    return withSystem(this.db, async (tx) => {
      const cred = b.secret
        ? await sealCredential(
            this.o,
            tx,
            a.tenantId,
            "api_key",
            b.kind === "telegram" ? { bot_token: b.secret } : { signing_secret: b.secret },
          )
        : null;
      const id = Bun.randomUUIDv7();
      const config = { name: b.name, ...(b.kind === "telegram" ? { chat_id: b.config.chat_id } : { url: b.config.url }) };
      await tx.execute(sql`insert into notification_channels (id, tenant_id, kind, config, credential_id, enabled)
        values (${id}, ${a.tenantId}, ${b.kind}::e_channel_kind, ${JSON.stringify(config)}::text::jsonb, ${cred?.id ?? null}, ${b.enabled ?? true})`);
      await this.audit(tx, a, "notification_channel.create", id, { kind: b.kind, name: b.name });
      return { id };
    });
  }

  async updateChannel(a: Actor, id: string, b: Partial<ChannelBody>) {
    return withSystem(this.db, async (tx) => {
      const [cur] = await rows<{
        kind: "telegram" | "webhook";
        config: ChannelBody["config"] & { name?: string };
        credential_id: string | null;
      }>(tx, sql`select kind, config, credential_id from notification_channels where id = ${id} and tenant_id = ${a.tenantId}`);
      if (!cur) throw new ApiError("NOT_FOUND", "Saluran tidak ditemukan");
      const config = { ...cur.config, ...(b.config ?? {}), ...(b.name ? { name: b.name } : {}) };
      await this.validateChannel({ kind: cur.kind, config, secret: b.secret }, false);
      let credId = cur.credential_id;
      if (b.secret) {
        const cred = await sealCredential(
          this.o,
          tx,
          a.tenantId,
          "api_key",
          cur.kind === "telegram" ? { bot_token: b.secret } : { signing_secret: b.secret },
        );
        if (cur.credential_id)
          await tx.execute(sql`update credentials set wrapped_dek = null, rotated_at = now() where id = ${cur.credential_id}`);
        credId = cred.id;
      }
      await tx.execute(sql`update notification_channels set config = ${JSON.stringify(config)}::text::jsonb, credential_id = ${credId},
          enabled = coalesce(${b.enabled ?? null}::boolean, enabled) where id = ${id}`);
      await this.audit(tx, a, "notification_channel.update", id, {
        fields: Object.keys(b).filter((k) => k !== "secret"),
        rotated: !!b.secret,
      });
      return { id };
    });
  }

  deleteChannel(a: Actor, id: string) {
    return withSystem(this.db, async (tx) => {
      const [c] = await rows<{ credential_id: string | null }>(
        tx,
        sql`delete from notification_channels where id = ${id} and tenant_id = ${a.tenantId} returning credential_id`,
      );
      if (!c) throw new ApiError("NOT_FOUND", "Saluran tidak ditemukan");
      if (c.credential_id) await tx.execute(sql`update credentials set wrapped_dek = null where id = ${c.credential_id}`); // hapus kriptografis
      await tx.execute(sql`update alert_rules set channels = array_remove(channels, ${id}::uuid) where tenant_id = ${a.tenantId}`);
      await this.audit(tx, a, "notification_channel.delete", id);
    });
  }

  /** Kirim pesan uji ke saluran (memastikan token/chat_id/URL benar). */
  async testChannel(a: Actor, id: string) {
    if (!this.o.http) throw new ApiError("INTERNAL", "HTTP klien tidak tersedia");
    const http = this.o.http;
    const target = await withSystem(this.db, async (tx) => {
      const [c] = await rows<{ id: string; kind: ChannelTarget["kind"]; config: ChannelTarget["config"]; credential_id: string | null }>(
        tx,
        sql`select id, kind, config, credential_id from notification_channels where id = ${id} and tenant_id = ${a.tenantId}`,
      );
      if (!c) throw new ApiError("NOT_FOUND", "Saluran tidak ditemukan");
      return { ...c, secret: c.credential_id ? await openCredential(this.o, tx, c.credential_id) : null } as ChannelTarget;
    });
    const msg: AlertMessage = {
      event_id: `test-${Bun.randomUUIDv7()}`,
      type: "test",
      title: "Uji saluran notifikasi SMIP",
      message: "Saluran ini sudah tersambung — alert akan dikirim ke sini.",
      topic: { id: "-", name: "-" },
      office: "-",
      fired_at: new Date().toISOString(),
    };
    return deliver(target, msg, async (url, init) => ({ status: (await http.request(url, { ...init, throwOnStatus: false })).status }));
  }
}
