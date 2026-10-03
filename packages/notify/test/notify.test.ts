import { describe, expect, test } from "bun:test";
import { type AlertMessage, deliver, telegramText, webhookHeaders } from "../src";

const M: AlertMessage = {
  event_id: "e1",
  type: "negative_ratio",
  title: "Sentimen negatif 62% (3 jam)",
  message: "62 dari 100 post negatif <cek>",
  topic: { id: "t1", name: "BPIP" },
  office: "Kantor A",
  fired_at: "2026-10-04T00:00:00.000Z",
  link: "https://contoh.local/?topic=t1",
};

describe("notify", () => {
  test("telegram: sendMessage HTML ter-escape, token hanya di URL; error tidak membocorkan token", async () => {
    const calls: { url: string; body: string }[] = [];
    const d = await deliver(
      { id: "c1", kind: "telegram", config: { chat_id: "-100" }, secret: { bot_token: "123:ABC" } },
      M,
      async (url, i) => {
        calls.push({ url, body: i.body });
        return { status: 200 };
      },
    );
    expect(d.status).toBe("sent");
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ chat_id: "-100", parse_mode: "HTML" });
    expect(telegramText(M)).toContain("&lt;cek&gt;");
    const bad = await deliver(
      { id: "c1", kind: "telegram", config: { chat_id: "-100" }, secret: { bot_token: "123:ABC" } },
      M,
      async () => {
        throw new Error("connect fail https://api.telegram.org/bot123:ABC/sendMessage");
      },
    );
    expect(bad.status).toBe("failed");
    expect(bad.error).not.toContain("123:ABC");
  });
  test("webhook: tanda tangan HMAC atas timestamp.body, status non-2xx = failed; email = skipped", async () => {
    const h = await webhookHeaders('{"a":1}', "rahasia", new Date("2026-10-04T00:00:00Z"));
    expect(h["x-smip-timestamp"]).toBe("1791072000");
    expect(h["x-smip-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect((await webhookHeaders("{}", undefined))["x-smip-signature"]).toBeUndefined();
    const d = await deliver({ id: "w", kind: "webhook", config: { url: "https://hook.example/x" }, secret: null }, M, async () => ({
      status: 500,
    }));
    expect(d).toMatchObject({ status: "failed", error: "HTTP 500" });
    expect(
      (await deliver({ id: "m", kind: "email", config: { to: ["a@b.c"] }, secret: null }, M, async () => ({ status: 200 }))).status,
    ).toBe("skipped");
  });
});
