// Registry connector runtime bun. Connector nyata ditambahkan di sini (I-17/I-18); `fake.*` hanya non-produksi.
import type { Connector } from "@smip/connector-sdk";
import { FakeConnector, fakeItem } from "@smip/connector-fake";

const FAKE_PLATFORMS = ["x", "instagram", "facebook", "threads", "tiktok", "youtube"];

/** Dev: 3 item per panggilan yang mengandung term query (1 di antaranya tidak cocok) → alur sampai ClickHouse terlihat. */
function demoItems(platform: string) {
  // nomor kecil: fakeItem menurunkan tanggal default dari n (n besar → tahun > 9999 → PARSE_ERROR)
  let n = Math.floor(Math.random() * 1_000_000);
  return (req: { query?: { native: string } }) => {
    const term = (req.query?.native ?? "demo")
      .replace(/["()]/g, "")
      .split(/\s+OR\s+/)[0]!
      .trim();
    const now = Date.now();
    return [0, 1, 2].map((k) =>
      fakeItem(platform, ++n, {
        text: k < 2 ? `${term} — contoh post dev ${n}` : `post dev lain ${n}`,
        published_at: new Date(now - (k + 1) * 60_000).toISOString(),
        metrics: {
          likes: k * 3,
          comments: null,
          shares: null,
          views: null,
          quotes: null,
          saves: null,
          captured_at: new Date(now).toISOString(),
        },
        provenance: {
          connector_key: `fake.${platform}`,
          connector_version: "0.1.0",
          fetched_at: new Date(now).toISOString(),
          raw_ref: null,
        },
      }),
    );
  };
}

export function connectorRegistry(env: string): Map<string, Connector> {
  const list: Connector[] = [];
  if (env !== "production") list.push(...FAKE_PLATFORMS.map((p) => new FakeConnector({ platform: p, autoRespond: demoItems(p) })));
  return new Map(list.map((c) => [c.manifest.key, c]));
}
