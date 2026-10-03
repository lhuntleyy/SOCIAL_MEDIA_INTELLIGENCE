// D-03 realtime (API_SPEC §7, SECURITY §7): worker mem-PUBLISH event ringan ke Redis (channel RT_CHANNEL) → tiap replika API
// SUBSCRIBE sekali dan meneruskan ke klien SSE lokal yang tenant+topiknya cocok. Klien hanya menerima "ada data baru" lalu
// memuat ulang query-nya sendiri (tidak ada data berat di SSE). Tiket SSE = cookie HttpOnly `sse_ticket` (Path=/v1/stream),
// TTL 15 menit, terikat sub+tid+topic_id, disimpan HASH-nya di Redis — token akses tidak pernah ada di URL.

export const RT_CHANNEL = "smip:rt";
export const TICKET_TTL_SEC = 900;
const HEARTBEAT_MS = 25_000;

export interface RtEvent {
  tenant_id: string;
  topic_id?: string | null;
  event: "aggregates.updated" | "alert.fired";
  data: Record<string, unknown>;
}
export interface Ticket {
  sub: string;
  tid: string;
  topic_id: string;
}
type Send = (ev: { event: string; data: unknown; id?: string }) => void;

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export class Realtime {
  private readonly clients = new Map<string, Set<Send>>();
  private seq = 0;
  constructor(
    private readonly cache: { send: (cmd: string, args: string[]) => Promise<unknown> },
    private readonly o: { heartbeatMs?: number } = {},
  ) {}

  /** Pasang ke subscriber Redis: `await sub.subscribe(RT_CHANNEL, (m) => rt.onMessage(m))`. */
  onMessage(raw: string) {
    let ev: RtEvent;
    try {
      ev = JSON.parse(raw) as RtEvent;
    } catch {
      return;
    }
    if (!ev?.tenant_id || !ev.event) return;
    const id = `${Date.now()}-${++this.seq}`;
    // event per topik → klien topik itu; event tanpa topik (mis. alert) → semua klien tenant itu
    for (const [key, set] of this.clients) {
      const [tid, topic] = key.split("|");
      if (tid !== ev.tenant_id || (ev.topic_id && topic !== ev.topic_id)) continue;
      for (const send of set) send({ event: ev.event, data: { ...ev.data, ...(ev.topic_id ? { topic_id: ev.topic_id } : {}) }, id });
    }
  }

  get connections() {
    let n = 0;
    for (const s of this.clients.values()) n += s.size;
    return n;
  }

  async issueTicket(t: Ticket): Promise<string> {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    await this.cache.send("SET", [`sse:t:${sha256(token)}`, JSON.stringify(t), "EX", String(TICKET_TTL_SEC)]);
    return token;
  }

  async readTicket(token: string | undefined): Promise<Ticket | null> {
    if (!token || token.length > 100) return null;
    const v = (await this.cache.send("GET", [`sse:t:${sha256(token)}`])) as string | null;
    return v ? (JSON.parse(v) as Ticket) : null;
  }

  /** Stream SSE untuk satu klien; berhenti saat `signal` abort (klien putus) atau tiket kedaluwarsa (klien membuka ulang). */
  stream(t: Ticket, signal: AbortSignal, expiresInMs = TICKET_TTL_SEC * 1000): ReadableStream<Uint8Array> {
    const key = `${t.tid}|${t.topic_id}`;
    const enc = new TextEncoder();
    let cleanup = () => {};
    return new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        const write = (s: string) => {
          try {
            ctrl.enqueue(enc.encode(s));
          } catch {
            cleanup();
          }
        };
        const send: Send = (ev) => write(`event: ${ev.event}\n${ev.id ? `id: ${ev.id}\n` : ""}data: ${JSON.stringify(ev.data)}\n\n`);
        const set = this.clients.get(key) ?? new Set<Send>();
        set.add(send);
        this.clients.set(key, set);
        write("retry: 5000\n\n");
        send({ event: "ready", data: { topic_id: t.topic_id } });
        const hb = setInterval(() => send({ event: "heartbeat", data: {} }), this.o.heartbeatMs ?? HEARTBEAT_MS);
        const expire = setTimeout(() => {
          send({ event: "ticket.expired", data: {} });
          cleanup();
        }, expiresInMs);
        cleanup = () => {
          clearInterval(hb);
          clearTimeout(expire);
          set.delete(send);
          if (!set.size) this.clients.delete(key);
          try {
            ctrl.close();
          } catch {
            /* sudah tertutup */
          }
        };
        signal.addEventListener("abort", () => cleanup(), { once: true });
      },
      cancel: () => cleanup(),
    });
  }
}
