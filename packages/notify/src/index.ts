// O-05: pengiriman notifikasi alert ke saluran kantor (Telegram, webhook). HTTP DIINJEKSI pemanggil (HttpClient connector-sdk
// dengan guard SSRF) — paket ini tidak membuka koneksi sendiri. Secret (token bot, kunci tanda tangan webhook) dibuka pemanggil
// sesaat dari credentials dan tidak pernah dicatat. Email belum didukung (butuh SMTP) → dilaporkan "skipped".

export type ChannelKind = "telegram" | "webhook" | "email";

export interface AlertMessage {
  /** id event (idempotensi di sisi penerima webhook) */
  event_id: string;
  type: string;
  title: string;
  message: string;
  topic: { id: string; name: string };
  office: string;
  fired_at: string;
  link?: string;
  metrics?: Record<string, unknown>;
}

export interface ChannelTarget {
  id: string;
  kind: ChannelKind;
  config: { chat_id?: string; url?: string; to?: string[] };
  /** telegram: { bot_token }; webhook: { signing_secret } (opsional) */
  secret: Record<string, string> | null;
}

export type Post = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

export interface Delivery {
  channel_id: string;
  kind: ChannelKind;
  status: "sent" | "failed" | "skipped";
  error?: string;
  at: string;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Teks Telegram (HTML parse mode) — singkat, tanpa data pribadi akun (hanya agregat). */
export function telegramText(m: AlertMessage): string {
  return [
    `🔔 <b>${esc(m.title)}</b>`,
    `Topik: ${esc(m.topic.name)} · ${esc(m.office)}`,
    esc(m.message),
    m.link ? `<a href="${esc(m.link)}">Buka dashboard</a>` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Header tanda tangan webhook: `X-SMIP-Signature: sha256=<hex HMAC(body)>` + `X-SMIP-Timestamp` (penerima tolak > 5 menit). */
export async function webhookHeaders(body: string, secret: string | undefined, now = new Date()): Promise<Record<string, string>> {
  const ts = String(Math.floor(now.getTime() / 1000));
  const h: Record<string, string> = { "content-type": "application/json", "x-smip-timestamp": ts, "user-agent": "SMIP-Alerts/1" };
  if (secret) h["x-smip-signature"] = `sha256=${await hmacHex(secret, `${ts}.${body}`)}`;
  return h;
}

export async function deliver(c: ChannelTarget, m: AlertMessage, post: Post, now = new Date()): Promise<Delivery> {
  const at = now.toISOString();
  const done = (status: Delivery["status"], error?: string): Delivery => ({
    channel_id: c.id,
    kind: c.kind,
    status,
    at,
    ...(error ? { error } : {}),
  });
  try {
    if (c.kind === "telegram") {
      const token = c.secret?.bot_token;
      if (!token || !c.config.chat_id) return done("failed", "token bot / chat_id belum diisi");
      const r = await post(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: c.config.chat_id, text: telegramText(m), parse_mode: "HTML", disable_web_page_preview: true }),
      });
      return r.status < 300 ? done("sent") : done("failed", `HTTP ${r.status}`);
    }
    if (c.kind === "webhook") {
      if (!c.config.url) return done("failed", "URL belum diisi");
      const body = JSON.stringify({ event: "alert.fired", ...m });
      const r = await post(c.config.url, { method: "POST", headers: await webhookHeaders(body, c.secret?.signing_secret, now), body });
      return r.status < 300 ? done("sent") : done("failed", `HTTP ${r.status}`);
    }
    return done("skipped", "email belum didukung (SMTP belum dikonfigurasi)");
  } catch (e) {
    // pesan error TIDAK boleh memuat URL berisi token bot
    return done("failed", String((e as Error).message ?? e).replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, "bot***"));
  }
}
