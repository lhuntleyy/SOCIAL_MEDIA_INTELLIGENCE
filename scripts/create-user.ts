// Operator (dev/demo): buat user + membership — `bun scripts/create-user.ts <email> "<nama>" <viewer|analyst|admin|owner> <tenant-slug>`
// Password acak dicetak SEKALI. admin/owner wajib mendaftarkan MFA saat login pertama; viewer/analyst tidak.
import postgres from "postgres";

const [email, name, role, slug] = process.argv.slice(2);
if (!email || !name || !role || !slug || !["viewer", "analyst", "admin", "owner"].includes(role))
  throw new Error('pakai: create-user.ts <email> "<nama>" <viewer|analyst|admin|owner> <tenant-slug>');
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const pw = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
const hash = await Bun.password.hash(pw, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
try {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE smip_system`;
    const [t] = await tx`select id from tenants where slug = ${slug}`;
    if (!t) throw new Error(`tenant ${slug} tidak ada`);
    const id = Bun.randomUUIDv7();
    await tx`insert into users (id, email, name, password_hash) values (${id}, ${email.toLowerCase()}, ${name}, ${hash})`;
    await tx`insert into memberships (tenant_id, user_id, role) values (${t.id}, ${id}, ${role})`;
  });
  console.log(`user ${email} (${role} @ ${slug}) dibuat — password: ${pw}   (dicetak sekali)`);
} finally {
  await sql.end();
}
