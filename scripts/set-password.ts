// Operator: set/reset password user (dev/demo) — `bun scripts/set-password.ts <email> [--operator]`.
// Password acak dicetak SEKALI ke stdout (tidak disimpan di mana pun); MFA user direset agar didaftarkan ulang saat login.
import postgres from "postgres";

const [email, ...flags] = process.argv.slice(2);
if (!email) throw new Error("pakai: bun scripts/set-password.ts <email> [--operator]");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL wajib");
const sql = postgres(url, { max: 1, onnotice: () => {} });
const pw = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
const hash = await Bun.password.hash(pw, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
try {
  const r = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE smip_system`;
    return tx`update users set password_hash = ${hash}, mfa_secret_enc = null,
      is_platform_operator = is_platform_operator or ${flags.includes("--operator")} where lower(email) = lower(${email}) returning id`;
  });
  if (!r.length) throw new Error(`user ${email} tidak ditemukan`);
  console.log(`password baru ${email}: ${pw}   (dicetak sekali; MFA akan diminta daftar ulang)`);
} finally {
  await sql.end();
}
