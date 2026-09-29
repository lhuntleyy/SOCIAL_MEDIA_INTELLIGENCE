import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, getViewAs, setViewAs } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Card, Empty, ErrorText, Input, Select } from "../ui";

interface Member {
  id: string;
  email: string;
  name: string;
  status: string;
  role: string;
}
interface Office {
  id: string;
  slug: string;
  name: string;
  status: string;
  users: number;
  topics: number;
  active_topics: number;
  topic_names: string[];
}

/** Peran disederhanakan jadi 3 (owner & admin sama-sama "Admin kantor"). */
const ROLE_LABEL: Record<string, string> = { owner: "Admin kantor", admin: "Admin kantor", analyst: "Analis", viewer: "Pembaca" };
const ROLE_HINT: Record<string, string> = {
  owner: "kelola user & topik",
  admin: "kelola user & topik",
  analyst: "buat & ubah topik",
  viewer: "hanya melihat dashboard",
};
const inviteLink = (token: string) => `${location.origin}/invite?token=${encodeURIComponent(token)}`;

function InviteResult({ token }: { token?: string }) {
  const [copied, setCopied] = useState(false);
  if (!token) return <p className="mt-2 rounded-lg bg-emerald-50 p-2 text-sm">User sudah terdaftar — langsung ditambahkan.</p>;
  const link = inviteLink(token);
  return (
    <div className="mt-2 rounded-lg bg-emerald-50 p-3 text-sm">
      <p className="mb-1 font-medium">Kirim link ini ke user (berlaku 72 jam, sekali pakai) — user membuat password sendiri:</p>
      <div className="flex gap-2">
        <code className="block flex-1 break-all rounded bg-white p-2 text-xs">{link}</code>
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
          }}
        >
          {copied ? "Tersalin" : "Salin"}
        </Button>
      </div>
    </div>
  );
}

/** Daftar user satu kantor + undang. `office` = mode administrator (kantor mana pun); tanpa `office` = kantor sendiri. */
function OfficeUsers({ office }: { office?: Office }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const tenantId = office?.id ?? me!.current_tenant.id;
  const key = ["users", tenantId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Member[]>(office ? `/admin/tenants/${office.id}/users` : "/users") });
  const isOwner = me?.current_tenant.role === "owner" || me?.user.is_platform_operator;
  const adminRole = office || isOwner ? "owner" : "admin";
  const [inv, setInv] = useState({ email: "", name: "", role: office ? "owner" : "analyst" });
  const invite = useMutation({
    mutationFn: () =>
      api<{ invite_token?: string }>(office ? `/admin/tenants/${office.id}/users` : "/users", {
        method: "POST",
        json: { ...inv, role: inv.role === "owner" ? adminRole : inv.role },
      }),
    onSuccess: () => {
      setInv({ email: "", name: "", role: "analyst" });
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
  const role = useMutation({
    mutationFn: (x: { id: string; role: string }) => api(`/users/${x.id}`, { method: "PATCH", json: { role: x.role } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/users/${id}/memberships/${tenantId}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
  const roleOptions = (current: string) =>
    [
      ["owner", "Admin kantor"],
      ["analyst", "Analis"],
      ["viewer", "Pembaca"],
    ].map(([k, v]) => (
      <option key={k} value={k === "owner" && current === "admin" ? "admin" : k}>
        {v}
      </option>
    ));
  return (
    <div className="space-y-3">
      <ErrorText error={q.error ?? role.error ?? remove.error} />
      {q.data && !q.data.length && <Empty>Belum ada user.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {q.data?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {u.name} {u.id === me?.user.id && <span className="text-xs text-zinc-400">(Anda)</span>}
              </div>
              <div className="truncate text-xs text-zinc-500">{u.email}</div>
            </div>
            {u.status === "invited" && <Badge tone="amber">belum menerima undangan</Badge>}
            {u.status === "disabled" && <Badge tone="red">nonaktif</Badge>}
            {office || u.id === me?.user.id || (u.role === "owner" && !isOwner) ? (
              <Badge tone={u.role === "owner" || u.role === "admin" ? "blue" : "zinc"}>{ROLE_LABEL[u.role] ?? u.role}</Badge>
            ) : (
              <Select
                className="py-1"
                value={u.role}
                onChange={(e) => role.mutate({ id: u.id, role: e.target.value === "owner" ? adminRole : e.target.value })}
              >
                {roleOptions(u.role)}
              </Select>
            )}
            {u.id !== me?.user.id && (
              <button
                type="button"
                className="text-xs text-zinc-400 hover:text-red-600"
                onClick={() => confirm(`Keluarkan ${u.email} dari kantor ini?`) && remove.mutate(u.id)}
              >
                keluarkan
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="rounded-lg bg-zinc-50 p-3">
        <div className="mb-2 text-xs font-semibold uppercase text-zinc-500">Undang user</div>
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
          <Input placeholder="Email" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
          <Input placeholder="Nama" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} />
          <Select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
            {[
              ["owner", "Admin kantor"],
              ["analyst", "Analis"],
              ["viewer", "Pembaca"],
            ].map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Button onClick={() => invite.mutate()} disabled={!inv.email || !inv.name || invite.isPending}>
            Undang
          </Button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          {ROLE_LABEL[inv.role]}: {ROLE_HINT[inv.role]}.{inv.role === "owner" && " Wajib autentikasi 2 langkah saat login pertama."}
        </p>
        <ErrorText error={invite.error} />
        {invite.data && <InviteResult token={invite.data.invite_token} />}
      </div>
    </div>
  );
}

function OfficeCard({ o, open, onToggle }: { o: Office; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toggle = useMutation({
    mutationFn: () => api(`/admin/tenants/${o.id}`, { method: "PATCH", json: { status: o.status === "active" ? "suspended" : "active" } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tenants"] }),
  });
  const viewAs = () => {
    const reason = prompt(`Alasan melihat data "${o.name}" (dicatat di audit, min. 10 karakter):`, "Pemantauan administrator");
    if (!reason || reason.trim().length < 10) return;
    setViewAs({ tenantId: o.id, tenantName: o.name, reason: reason.trim() });
    qc.clear();
    nav("/");
  };
  return (
    <section className="rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold">
              {o.name}
              {o.status !== "active" && <Badge tone="red">dibekukan</Badge>}
            </div>
            <div className="truncate text-xs text-zinc-500">
              {o.users} user · {o.active_topics} topik aktif
              {o.topic_names.length ? ` — ${o.topic_names.join(", ")}` : ""}
            </div>
          </div>
        </button>
        <Button variant="ghost" onClick={viewAs}>
          Lihat data
        </Button>
        <button
          type="button"
          className="text-xs text-zinc-400 hover:text-red-600"
          onClick={() => (o.status !== "active" || confirm(`Bekukan ${o.name}? User kantor ini tidak bisa login.`)) && toggle.mutate()}
        >
          {o.status === "active" ? "bekukan" : "aktifkan"}
        </button>
      </div>
      <ErrorText error={toggle.error} />
      {open && (
        <div className="border-t border-zinc-100 p-4">
          <OfficeUsers office={o} />
        </div>
      )}
    </section>
  );
}

function Offices() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tenants"], queryFn: () => api<Office[]>("/admin/tenants") });
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => {
      const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32);
      return api<{ id: string }>("/admin/tenants", {
        method: "POST",
        json: { name: name.trim(), slug: `${base.length >= 2 ? base : "kantor"}-${Date.now().toString(36).slice(-4)}` },
      });
    },
    onSuccess: (r) => {
      setName("");
      setOpen(r.id);
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
  return (
    <div className="space-y-3">
      <Card title="Kantor & pengguna" right={<span className="text-xs text-zinc-500">{q.data?.length ?? 0} kantor</span>}>
        <p className="mb-3 text-sm text-zinc-600">
          Tiap kantor punya topik & data sendiri dan tidak bisa melihat kantor lain. Tambah kantor, lalu undang admin kantornya — admin
          kantor bisa menambah user-nya sendiri.
        </p>
        <div className="flex gap-2">
          <Input placeholder="Nama kantor baru (mis. Kantor A)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button onClick={() => create.mutate()} disabled={name.trim().length < 2 || create.isPending}>
            Tambah kantor
          </Button>
        </div>
        <ErrorText error={q.error ?? create.error} />
      </Card>
      {q.data?.map((o) => (
        <OfficeCard key={o.id} o={o} open={open === o.id} onToggle={() => setOpen(open === o.id ? null : o.id)} />
      ))}
    </div>
  );
}

/** Administrator platform → semua kantor + user-nya; admin kantor → user kantornya sendiri. */
export default function Users() {
  const { me } = useAuth();
  if (me?.user.is_platform_operator && !getViewAs()) return <Offices />;
  const name = me?.tenants.find((t) => t.id === me.current_tenant.id)?.name;
  return (
    <Card title={`Pengguna ${getViewAs()?.tenantName ?? name ?? "kantor"}`}>
      <OfficeUsers />
    </Card>
  );
}

/** Halaman publik: terima undangan → buat password (min. 12 karakter). */
export function AcceptInvite() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const m = useMutation({
    mutationFn: () => api("/auth/accept-invite", { method: "POST", json: { token: sp.get("token") ?? "", password: pw } }),
    onSuccess: () => setTimeout(() => nav("/login"), 1500),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pw === pw2) m.mutate();
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-8 shadow-lg">
        <div className="text-2xl font-bold text-brand-600">SMIP</div>
        <p className="text-sm text-zinc-600">Buat password untuk akun Anda (minimal 12 karakter).</p>
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="Password baru"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          minLength={12}
          required
        />
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="Ulangi password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          required
        />
        {pw2 && pw !== pw2 && <p className="text-xs text-red-600">Password tidak sama.</p>}
        <ErrorText error={m.error} />
        {m.isSuccess && <p className="text-sm text-emerald-700">Berhasil — mengarahkan ke halaman login…</p>}
        <Button type="submit" className="w-full py-2" disabled={m.isPending || pw.length < 12 || pw !== pw2}>
          Simpan password
        </Button>
      </form>
    </div>
  );
}
