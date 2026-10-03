import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, getViewAs } from "../api";
import { useAuth } from "../auth";
import { type Office, useEnterOffice } from "../office";
import { Badge, Button, Card, Empty, ErrorText, Input, Select, Tabs } from "../ui";

interface Member {
  id: string;
  email: string;
  name: string;
  status: string;
  role: string;
}

/** Peran: Owner = pemilik platform (di luar kantor). Di dalam kantor: Admin kantor (owner/admin), Analis, Pembaca. */
const ROLE_LABEL: Record<string, string> = { owner: "Admin kantor", admin: "Admin kantor", analyst: "Analis", viewer: "Pembaca" };
const ROLE_HINT: Record<string, string> = {
  owner: "kelola user & topik kantornya",
  admin: "kelola user & topik kantornya",
  analyst: "buat & ubah topik, lihat semua data",
  viewer: "hanya melihat dashboard",
};
const ROLE_OPTIONS = [
  ["owner", "Admin kantor"],
  ["analyst", "Analis"],
  ["viewer", "Pembaca"],
] as const;
const linkFor = (token: string) => `${location.origin}/invite?token=${encodeURIComponent(token)}`;

function CopyLink({ token, label }: { token: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const link = linkFor(token);
  return (
    <div className="mt-2 rounded-lg bg-emerald-50 p-3 text-sm">
      <p className="mb-1 font-medium">{label}</p>
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

/** Form tambah user: password opsional — diisi = user langsung bisa login; kosong = link undangan. */
function NewUserForm({
  title,
  roles,
  defaultRole,
  onSubmit,
}: {
  title: string;
  roles?: readonly (readonly [string, string])[];
  defaultRole?: string;
  onSubmit: (b: {
    email: string;
    name: string;
    role?: string;
    password?: string;
  }) => Promise<{ invite_token?: string; password_ignored?: boolean }>;
}) {
  const empty = { email: "", name: "", role: defaultRole ?? "analyst", password: "" };
  const [v, setV] = useState(empty);
  const m = useMutation({
    mutationFn: () =>
      onSubmit({ email: v.email, name: v.name, ...(roles ? { role: v.role } : {}), ...(v.password ? { password: v.password } : {}) }),
    onSuccess: () => setV({ ...empty, role: v.role }),
  });
  const pwBad = v.password.length > 0 && v.password.length < 12;
  return (
    <div className="rounded-lg bg-zinc-50 p-3">
      <div className="mb-2 text-xs font-semibold uppercase text-zinc-500">{title}</div>
      <div className={`grid gap-2 ${roles ? "md:grid-cols-[1fr_1fr_auto_1fr_auto]" : "md:grid-cols-[1fr_1fr_1fr_auto]"}`}>
        <Input placeholder="Email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        <Input placeholder="Nama" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        {roles && (
          <Select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
            {roles.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        )}
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="Password (opsional)"
          value={v.password}
          onChange={(e) => setV({ ...v, password: e.target.value })}
        />
        <Button onClick={() => m.mutate()} disabled={!v.email || !v.name || pwBad || m.isPending}>
          Tambah
        </Button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {roles && `${ROLE_LABEL[v.role]}: ${ROLE_HINT[v.role]}. `}
        {pwBad
          ? "Password minimal 12 karakter."
          : "Isi password → user langsung bisa login (berikan password-nya). Kosongkan → dapat link undangan untuk membuat password sendiri."}
        {v.role === "owner" && roles && " Admin kantor wajib autentikasi 2 langkah saat login pertama."}
      </p>
      <ErrorText error={m.error} />
      {m.data?.invite_token && (
        <CopyLink token={m.data.invite_token} label="Kirim link undangan ini ke user (berlaku 72 jam, sekali pakai):" />
      )}
      {m.isSuccess && !m.data?.invite_token && (
        <p className="mt-2 rounded-lg bg-emerald-50 p-2 text-sm">
          {m.data?.password_ignored
            ? "Email sudah terdaftar — user ditambahkan, password lamanya tidak diubah."
            : "Berhasil ditambahkan — user bisa langsung login."}
        </p>
      )}
    </div>
  );
}

/** Ganti password user lain: isi password baru, atau buat link reset (sekali pakai, 72 jam). Sesi lama user dicabut. */
function ResetPassword({ path, onDone }: { path: string; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const m = useMutation({
    mutationFn: (withPw: boolean) => api<{ reset_token?: string }>(path, { method: "POST", json: withPw ? { password: pw } : {} }),
  });
  return (
    <div className="mt-2 w-full rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="flex flex-wrap gap-2">
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="Password baru (min. 12 karakter)"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          className="max-w-xs"
        />
        <Button onClick={() => m.mutate(true)} disabled={pw.length < 12 || m.isPending}>
          Simpan password
        </Button>
        <span className="self-center text-xs text-zinc-500">atau</span>
        <Button variant="ghost" onClick={() => m.mutate(false)} disabled={m.isPending}>
          Buat link reset
        </Button>
        <button type="button" className="ml-auto text-xs text-zinc-500" onClick={onDone}>
          tutup
        </button>
      </div>
      <ErrorText error={m.error} />
      {m.data?.reset_token && (
        <CopyLink token={m.data.reset_token} label="Kirim link ini ke user untuk membuat password baru (72 jam, sekali pakai):" />
      )}
      {m.isSuccess && !m.data?.reset_token && <p className="mt-2 text-sm text-emerald-700">Password diganti — user harus login ulang.</p>}
    </div>
  );
}

/** Daftar user satu kantor. `office` = mode owner platform (kantor mana pun); tanpa `office` = kantor sendiri. */
function OfficeUsers({ office }: { office?: Office }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const tenantId = office?.id ?? me!.current_tenant.id;
  const key = ["users", tenantId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Member[]>(office ? `/admin/tenants/${office.id}/users` : "/users") });
  const isOwner = me?.current_tenant.role === "owner" || me?.user.is_platform_operator;
  const adminRole = office || isOwner ? "owner" : "admin";
  const [resetFor, setResetFor] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["tenants"] });
    void qc.invalidateQueries({ queryKey: ["all-users"] });
  };
  const role = useMutation({
    mutationFn: (x: { id: string; role: string }) => api(`/users/${x.id}`, { method: "PATCH", json: { role: x.role } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/users/${id}/memberships/${tenantId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  return (
    <div className="space-y-3">
      <ErrorText error={q.error ?? role.error ?? remove.error} />
      {q.data && !q.data.length && <Empty>Belum ada user.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {q.data?.map((u) => {
          const canManage = u.id !== me?.user.id && (u.role !== "owner" || isOwner);
          return (
            <li key={u.id} className="flex flex-wrap items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {u.name} {u.id === me?.user.id && <span className="text-xs text-zinc-400">(Anda)</span>}
                </div>
                <div className="truncate text-xs text-zinc-500">{u.email}</div>
              </div>
              {u.status === "invited" && <Badge tone="amber">belum menerima undangan</Badge>}
              {u.status === "disabled" && <Badge tone="red">nonaktif</Badge>}
              {office || !canManage ? (
                <Badge tone={u.role === "owner" || u.role === "admin" ? "blue" : "zinc"}>{ROLE_LABEL[u.role] ?? u.role}</Badge>
              ) : (
                <Select
                  className="py-1"
                  value={u.role === "admin" ? "owner" : u.role}
                  onChange={(e) => role.mutate({ id: u.id, role: e.target.value === "owner" ? adminRole : e.target.value })}
                >
                  {ROLE_OPTIONS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              )}
              {canManage && (
                <>
                  <button
                    type="button"
                    className="text-xs text-zinc-500 hover:text-brand-600"
                    onClick={() => setResetFor(resetFor === u.id ? null : u.id)}
                  >
                    reset password
                  </button>
                  <button
                    type="button"
                    className="text-xs text-zinc-400 hover:text-red-600"
                    onClick={() => confirm(`Keluarkan ${u.email} dari kantor ini?`) && remove.mutate(u.id)}
                  >
                    keluarkan
                  </button>
                </>
              )}
              {resetFor === u.id && (
                <ResetPassword
                  path={office ? `/admin/users/${u.id}/password` : `/users/${u.id}/password`}
                  onDone={() => setResetFor(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
      <NewUserForm
        title="Tambah user"
        roles={ROLE_OPTIONS}
        defaultRole={office ? "owner" : "analyst"}
        onSubmit={async (b) => {
          const r = await api<{ invite_token?: string; password_ignored?: boolean }>(
            office ? `/admin/tenants/${office.id}/users` : "/users",
            {
              method: "POST",
              json: { ...b, role: b.role === "owner" ? adminRole : b.role },
            },
          );
          refresh();
          return r;
        }}
      />
    </div>
  );
}

interface PackageRow {
  code: string;
  name: string;
  description: string | null;
  platform_intervals: Record<string, number> | null;
}

/** Paket kantor = jadwal pengambilan semua topik kantor itu (biaya per paket: Pengaturan → Batas & jadwal). */
function OfficePackage({ o }: { o: Office }) {
  const qc = useQueryClient();
  const pk = useQuery({ queryKey: ["plans"], queryFn: () => api<PackageRow[]>("/admin/plans"), staleTime: 600_000 });
  const save = useMutation({
    mutationFn: (code: string) => api(`/admin/tenants/${o.id}`, { method: "PATCH", json: { plan_code: code } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tenants"] }),
  });
  const list = pk.data ?? [];
  const cur = list.find((p) => p.code === o.plan_code);
  return (
    <span
      className="flex items-center gap-2 text-xs text-zinc-500"
      title={cur?.description ?? "Mengikuti jadwal bawaan di Pengaturan → Batas & jadwal"}
    >
      <label htmlFor={`pkg-${o.id}`}>Paket</label>
      <Select
        id={`pkg-${o.id}`}
        value={o.plan_code ?? ""}
        onChange={(e) => save.mutate(e.target.value)}
        disabled={save.isPending}
        className="py-1 text-sm"
      >
        {!o.plan_code && <option value="">— jadwal bawaan —</option>}
        {list.map((p) => (
          <option key={p.code} value={p.code}>
            {p.name}
            {p.description ? ` — ${p.description}` : " (jadwal bawaan)"}
          </option>
        ))}
      </Select>
      {save.error && <span className="text-red-600">{(save.error as Error).message}</span>}
    </span>
  );
}

function OfficeCard({ o, open, onToggle }: { o: Office; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const enter = useEnterOffice();
  const toggle = useMutation({
    mutationFn: () => api(`/admin/tenants/${o.id}`, { method: "PATCH", json: { status: o.status === "active" ? "suspended" : "active" } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tenants"] }),
  });
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
        <OfficePackage o={o} />
        <Button variant="ghost" onClick={() => enter(o)}>
          Masuk ke kantor
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
      <Card>
        <p className="mb-3 text-sm text-zinc-600">
          Tiap kantor punya topik & data sendiri dan tidak bisa melihat kantor lain. Tambah kantor, lalu tambahkan admin kantornya — admin
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

interface AnyUser {
  id: string;
  email: string;
  name: string;
  status: string;
  last_login_at: string | null;
  offices: { tenant_id: string; tenant: string; role: string }[];
}
function AllUsers() {
  const q = useQuery({ queryKey: ["all-users"], queryFn: () => api<AnyUser[]>("/admin/users") });
  const [search, setSearch] = useState("");
  const [resetFor, setResetFor] = useState<string | null>(null);
  const s = search.toLowerCase();
  const list = q.data?.filter((u) => !s || `${u.name} ${u.email} ${u.offices.map((o) => o.tenant).join(" ")}`.toLowerCase().includes(s));
  return (
    <Card>
      <Input placeholder="Cari nama, email, atau kantor…" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3" />
      <ErrorText error={q.error} />
      {list && !list.length && <Empty>Tidak ada user.</Empty>}
      <ul className="divide-y divide-zinc-100">
        {list?.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{u.name}</div>
              <div className="truncate text-xs text-zinc-500">{u.email}</div>
            </div>
            {u.status === "invited" && <Badge tone="amber">belum menerima undangan</Badge>}
            {u.status === "disabled" && <Badge tone="red">nonaktif</Badge>}
            <div className="flex flex-wrap gap-1">
              {u.offices.length ? (
                u.offices.map((o) => (
                  <Badge key={o.tenant_id} tone={o.role === "owner" || o.role === "admin" ? "blue" : "zinc"}>
                    {o.tenant} · {ROLE_LABEL[o.role] ?? o.role}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-zinc-400">tanpa kantor</span>
              )}
            </div>
            <button
              type="button"
              className="text-xs text-zinc-500 hover:text-brand-600"
              onClick={() => setResetFor(resetFor === u.id ? null : u.id)}
            >
              reset password
            </button>
            {resetFor === u.id && <ResetPassword path={`/admin/users/${u.id}/password`} onDone={() => setResetFor(null)} />}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Owners() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["owners"],
    queryFn: () => api<{ id: string; email: string; name: string; status: string; last_login_at: string | null }[]>("/admin/owners"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/admin/owners/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["owners"] }),
  });
  return (
    <Card>
      <p className="mb-3 text-sm text-zinc-600">
        Owner = pemilik platform: tidak berada di kantor mana pun, bisa melihat semua kantor & user, mengatur sumber data & AI, dan menambah
        owner lain. Wajib autentikasi 2 langkah.
      </p>
      <ErrorText error={q.error ?? remove.error} />
      <ul className="mb-3 divide-y divide-zinc-100">
        {q.data?.map((o) => (
          <li key={o.id} className="flex items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {o.name} {o.id === me?.user.id && <span className="text-xs text-zinc-400">(Anda)</span>}
              </div>
              <div className="truncate text-xs text-zinc-500">{o.email}</div>
            </div>
            {o.status === "invited" && <Badge tone="amber">belum menerima undangan</Badge>}
            <Badge tone="blue">Owner</Badge>
            {o.id !== me?.user.id && (
              <button
                type="button"
                className="text-xs text-zinc-400 hover:text-red-600"
                onClick={() => confirm(`Cabut status owner ${o.email}?`) && remove.mutate(o.id)}
              >
                cabut
              </button>
            )}
          </li>
        ))}
      </ul>
      <NewUserForm
        title="Tambah owner"
        onSubmit={async (b) => {
          const r = await api<{ invite_token?: string }>("/admin/owners", { method: "POST", json: b });
          void qc.invalidateQueries({ queryKey: ["owners"] });
          return r;
        }}
      />
    </Card>
  );
}

type Tab = "offices" | "users" | "owners";
/** Owner platform → Kantor / Semua pengguna / Owner; admin kantor → user kantornya sendiri. */
export default function Users() {
  const { me } = useAuth();
  const [sp, setSp] = useSearchParams();
  if (me?.user.is_platform_operator && !getViewAs()) {
    const tab = (["offices", "users", "owners"].includes(sp.get("tab") ?? "") ? sp.get("tab") : "offices") as Tab;
    return (
      <div className="space-y-4">
        <Tabs
          tabs={[
            { id: "offices", label: "Kantor" },
            { id: "users", label: "Semua pengguna" },
            { id: "owners", label: "Owner" },
          ]}
          value={tab}
          onChange={(v) => setSp({ tab: v }, { replace: true })}
        />
        {tab === "offices" && <Offices />}
        {tab === "users" && <AllUsers />}
        {tab === "owners" && <Owners />}
      </div>
    );
  }
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
        <p className="text-sm text-zinc-600">Buat password baru untuk akun Anda (minimal 12 karakter).</p>
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
