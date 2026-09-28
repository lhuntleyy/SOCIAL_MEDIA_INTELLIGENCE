// bun run ch:migrate [up | down [--steps N | --to N] | status]   (CLICKHOUSE_URL, CLICKHOUSE_DB, CLICKHOUSE_USER/PASSWORD)
import { createClient } from "@clickhouse/client";
import { chDown, chStatus, chUp } from "../packages/analytics/src";

const url = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const database = process.env.CLICKHOUSE_DB ?? "smip";
const auth = { username: process.env.CLICKHOUSE_USER ?? "default", password: process.env.CLICKHOUSE_PASSWORD ?? "" };
const [cmd = "status", ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(n);
  return i >= 0 ? Number(rest[i + 1]) : undefined;
};
const admin = createClient({ url, ...auth });
await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
await admin.close();
const ch = createClient({ url, database, ...auth });
try {
  if (cmd === "up") console.log("diterapkan:", await chUp(ch));
  else if (cmd === "down") console.log("diturunkan:", await chDown(ch, { steps: flag("--steps"), to: flag("--to") }));
  else {
    const s = await chStatus(ch);
    console.log(
      "applied:",
      s.applied,
      "pending:",
      s.pending.map((m) => `${m.version}_${m.name}`),
    );
  }
} finally {
  await ch.close();
}
