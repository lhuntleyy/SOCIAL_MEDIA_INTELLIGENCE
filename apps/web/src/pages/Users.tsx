import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Card, Empty, ErrorText, Input } from "../ui";
import { inviteLink } from "./Tenants";

interface Member {
  id: string;
  email: string;
  name: string;
  status: string;
  role: string;
}
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", analyst: "Analis", viewer: "Viewer" };

/** Admin kantor: kelola user kantornya sendiri (RLS tenant — tidak melihat kantor lain). */
export default function Users() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api<Member[]>("/users") });
  const [inv, setInv] = useState({ email: "", name: "", role: "analyst" });
  const invite = useMutation({
    mutationFn: () => api<{ invite_token?: string }>("/users", { method: "POST", json: inv }),
    onSuccess: () => {
      setInv({ email: "", name: "", role: "analyst" });
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const role = useMutation({
    mutationFn: (x: { id: string; role: string }) => api(`/users/${x.id}`, { method: "PATCH", json: { role: x.role } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/users/${id}/memberships/${me!.current_tenant.id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const canOwner = me?.current_tenant.role === "owner" || me?.user.is_platform_operator;
  return (
    <div className="space-y-4">
      <Card title="Pengguna kantor">
        <ErrorText error={q.error ?? role.error ?? remove.error} />
        {q.data && !q.data.length && <Empty>Belum ada user.</Empty>}
        <table className="w-full text-sm">
          <tbody className="divide-y divide-zinc-100">
            {q.data?.map((u) => (
              <tr key={u.id}>
                <td className="py-2">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-zinc-500">{u.email}</div>
                </td>
                <td>
                  {u.status !== "active" && <Badge tone="amber">{u.status === "invited" ? "belum menerima undangan" : u.status}</Badge>}
                </td>
                <td>
                  <select
                    className="rounded-lg border border-zinc-300 px-2 py-1 text-sm"
                    value={u.role}
                    disabled={u.id === me?.user.id || (u.role === "owner" && !canOwner)}
                    onChange={(e) => role.mutate({ id: u.id, role: e.target.value })}
                  >
                    {Object.entries(ROLE_LABEL)
                      .filter(([k]) => k !== "owner" || canOwner)
                      .map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                  </select>
                </td>
                <td className="text-right">
                  {u.id !== me?.user.id && (
                    <Button variant="danger" onClick={() => confirm(`Keluarkan ${u.email} dari kantor ini?`) && remove.mutate(u.id)}>
                      Keluarkan
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Undang user baru">
        <div className="grid gap-2 md:grid-cols-4">
          <Input placeholder="Email" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
          <Input placeholder="Nama" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} />
          <select
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            value={inv.role}
            onChange={(e) => setInv({ ...inv, role: e.target.value })}
          >
            {Object.entries(ROLE_LABEL)
              .filter(([k]) => k !== "owner" || canOwner)
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </select>
          <Button onClick={() => invite.mutate()} disabled={!inv.email || !inv.name || invite.isPending}>
            Undang
          </Button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Admin & owner wajib memakai autentikasi 2 langkah saat login pertama. Viewer hanya bisa membaca.
        </p>
        <ErrorText error={invite.error} />
        {invite.data?.invite_token && (
          <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm">
            <p className="mb-1 font-medium">Kirim link undangan ini (72 jam, sekali pakai):</p>
            <code className="block break-all rounded bg-white p-2 text-xs">{inviteLink(invite.data.invite_token)}</code>
          </div>
        )}
      </Card>
    </div>
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
