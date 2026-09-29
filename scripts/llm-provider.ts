// Operator: daftarkan provider LLM + API key dari ENV (nilai tidak pernah dicetak) — setara panel "Pengaturan AI".
//   bun --env-file=infra/compose/.env.dev scripts/llm-provider.ts <key> <gemini|openai_compatible|anthropic> "<Nama>" <ENV_VAR_KEY> [base_url]
// Lalu: refresh katalog model; bila tugas `default` belum diatur → pakai model default yang diberikan lewat LLM_DEFAULT_MODEL.
import { HttpClient } from "@smip/connector-sdk";
import { createKms } from "@smip/crypto";
import { createDb, withSystem } from "@smip/db";
import { sql } from "drizzle-orm";
import { LlmAdminService } from "../apps/api/src/admin/llm";

const [key, kind, name, envVar, baseUrl] = process.argv.slice(2);
if (!key || !kind || !name || !envVar) throw new Error("pakai: llm-provider.ts <key> <kind> <nama> <ENV_VAR_KEY> [base_url]");
const apiKey = process.env[envVar];
if (!apiKey) throw new Error(`env ${envVar} kosong`);
const { db, close } = createDb(process.env.DATABASE_URL!, { max: 1 });
const svc = new LlmAdminService(db, {
  kms: createKms({ NODE_ENV: process.env.NODE_ENV ?? "development", ...process.env }),
  fingerprintPepper: new Uint8Array(Buffer.from(process.env.CREDENTIAL_PEPPER_B64!, "base64")),
  http: new HttpClient({ timeoutMs: 30_000 }),
});
const actor = { userId: "00000000-0000-0000-0000-000000000000", tenantId: "00000000-0000-0000-0000-000000000000" };
try {
  const existing = (await withSystem(db, (tx) => tx.execute(sql`select id from llm_providers where key = ${key}`))) as unknown as {
    id: string;
  }[];
  const id =
    existing[0]?.id ??
    (await svc.createProvider(actor, { key, name, kind: kind as never, base_url: baseUrl ?? null, api_key: apiKey, key_label: "key-1" }));
  console.log(`provider ${key}: ${id}`);
  console.log("model:", await svc.refreshModels(actor, id));
  const model = process.env.LLM_DEFAULT_MODEL;
  if (model) {
    for (const task of ["default", "sentiment", "emotion"] as const)
      await svc.putTask(actor, task, { provider_id: id, model_id: model, enabled: true, params: { batch_size: 20 } });
    console.log(`tugas default/sentiment/emotion → ${model}`);
  }
} finally {
  await close();
}
