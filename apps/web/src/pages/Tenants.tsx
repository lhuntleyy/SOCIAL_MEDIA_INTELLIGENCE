import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, setViewAs } from "../api";
import { Badge, Button, Card, Empty, ErrorText, Input } from "../ui";

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  users: number;
  topics: number;
  active_topics: number;
  topic_names: string[];
}
const ROLES = [
  { id: "owner", label: "Owner (admin utama kantor)" },
  { id: "admin", label: "Admin" },
  { id: "analyst", label: "Analis" },
  { id: "viewer", label: "Viewer (hanya-baca)" },
];

export const inviteLink = (token: string) => `${location.origin}/invite?token=${encodeURIComponent(token)}`;

/** Administrator platform: kelola kantor (tenant), undang admin kantor, dan lihat semua topik tiap kantor. */
export default function Tenants() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["tenants"], queryFn: () => api<Tenant[]>("/admin/tenants") });
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const create = useMutation({
    mutationFn: () => api("/admin/tenants", { method: "POST", json: { name, slug } }),
    onSuccess: () => {
      setName("");
      setSlug("");
      void qc.invalidateQueries({ queryKey: ["tenants"] });
    },
  });
  const [inviteFor, setInviteFor] = useState<Tenant | null>(null);
  const [inv, setInv] = useState({ email: "", name: "", role: "owner" });
  const invite = useMutation({
    mutationFn: () =>
      api<{ invite_token?: string; status: string }>(`/admin/tenants/${inviteFor!.id}/users`, { method: "POST", json: inv }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tenants"] }),
  });
  const toggle = useMutation({
    mutationFn: (t: Tenant) =>
      api(`/admin/tenants/${t.id}`, { method: "PATCH", json: { status: t.status === "active" ? "suspended" : "active" } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["tenants"] }),
  });
  const viewAs = (t: Tenant) => {
    const reason = prompt(`Alasan melihat data kantor "${t.name}" (dicatat di audit, min. 10 karakter):`, "Pemantauan administrator");
    if (!reason || reason.trim().length < 10) return;
    setViewAs({ tenantId: t.id, tenantName: t.name, reason: reason.trim() });
    qc.clear();
    nav("/");
  };
  return (
    <div className="space-y-4">
      <Card title="Kantor (tenant)" right={<span className="text-xs text-zinc-500">{q.data?.length ?? 0} kantor</span>}>
        <ErrorText error={q.error ?? toggle.error} />
        {q.data && !q.data.length && <Empty>Belum ada kantor.</Empty>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="py-2">Kantor</th>
                <th>Status</th>
                <th className="text-right">User</th>
                <th className="text-right">Topik aktif</th>
                <th>Topik</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 align-top">
              {q.data?.map((t) => (
                <tr key={t.id}>
                  <td className="py-2">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-zinc-500">{t.slug}</div>
                  </td>
                  <td>
                    <Badge tone={t.status === "active" ? "green" : "red"}>{t.status}</Badge>
                  </td>
                  <td className="text-right tabular-nums">{t.users}</td>
                  <td className="text-right tabular-nums">
                    {t.active_topics}/{t.topics}
                  </td>
                  <td className="max-w-[260px] text-xs text-zinc-600">{t.topic_names.join(", ") || "—"}</td>
                  <td className="space-x-1 whitespace-nowrap text-right">
                    <Button variant="ghost" onClick={() => viewAs(t)}>
                      Lihat data
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setInviteFor(t);
                        invite.reset();
                      }}
                    >
                      Undang user
                    </Button>
                    <Button variant={t.status === "active" ? "danger" : "primary"} onClick={() => toggle.mutate(t)}>
                      {t.status === "active" ? "Bekukan" : "Aktifkan"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {inviteFor && (
        <Card
          title={`Undang user ke ${inviteFor.name}`}
          right={
            <Button variant="ghost" onClick={() => setInviteFor(null)}>
              Tutup
            </Button>
          }
        >
          <div className="grid gap-2 md:grid-cols-4">
            <Input placeholder="Email" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            <Input placeholder="Nama" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} />
            <select
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              value={inv.role}
              onChange={(e) => setInv({ ...inv, role: e.target.value })}
            >
              {ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <Button onClick={() => invite.mutate()} disabled={!inv.email || !inv.name || invite.isPending}>
              Undang
            </Button>
          </div>
          <ErrorText error={invite.error} />
          {invite.data && (
            <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm">
              {invite.data.invite_token ? (
                <>
                  <p className="mb-1 font-medium">Kirim link undangan ini ke user (berlaku 72 jam, sekali pakai):</p>
                  <code className="block break-all rounded bg-white p-2 text-xs">{inviteLink(invite.data.invite_token)}</code>
                </>
              ) : (
                <p>User sudah terdaftar — langsung ditambahkan ke kantor ini.</p>
              )}
            </div>
          )}
        </Card>
      )}

      <Card title="Tambah kantor">
        <div className="grid gap-2 md:grid-cols-[2fr_1fr_auto]">
          <Input
            placeholder="Nama kantor (mis. Kantor A)"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSlug(
                e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-|-$/g, "")
                  .slice(0, 40),
              );
            }}
          />
          <Input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
          <Button onClick={() => create.mutate()} disabled={name.length < 2 || slug.length < 2 || create.isPending}>
            Tambah
          </Button>
        </div>
        <ErrorText error={create.error} />
      </Card>
    </div>
  );
}
