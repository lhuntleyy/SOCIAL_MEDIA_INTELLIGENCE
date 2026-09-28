// bun run db:migrate [up [--to N] | down [--steps N | --to N] | status]   (DATABASE_URL wajib; role pemilik skema)
import postgres from "postgres";
import { down, status, up } from "../packages/db/src/migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL wajib");
const [cmd = "status", ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(n);
  return i >= 0 ? Number(rest[i + 1]) : undefined;
};
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  if (cmd === "up") console.log("diterapkan:", await up(sql, { to: flag("--to") }));
  else if (cmd === "down") console.log("diturunkan:", await down(sql, { steps: flag("--steps"), to: flag("--to") }));
  else {
    const s = await status(sql);
    console.log(
      "applied:",
      s.applied,
      "pending:",
      s.pending.map((m) => `${m.version}_${m.name}`),
    );
  }
} finally {
  await sql.end();
}
