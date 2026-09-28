// Registry connector runtime bun. Connector nyata ditambahkan di sini (I-17/I-18); `fake.*` hanya non-produksi.
import type { Connector } from "@smip/connector-sdk";
import { FakeConnector } from "@smip/connector-fake";

const FAKE_PLATFORMS = ["x", "instagram", "facebook", "threads", "tiktok", "youtube"];

export function connectorRegistry(env: string): Map<string, Connector> {
  const list: Connector[] = [];
  if (env !== "production") list.push(...FAKE_PLATFORMS.map((p) => new FakeConnector({ platform: p })));
  return new Map(list.map((c) => [c.manifest.key, c]));
}
