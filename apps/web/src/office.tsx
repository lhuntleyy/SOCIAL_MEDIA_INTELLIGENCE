// Owner platform tidak berada di kantor mana pun: data kantor dilihat lewat "masuk ke kantor" (impersonasi yang diaudit).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, getViewAs, setViewAs } from "./api";
import { useAuth } from "./auth";
import { Badge, Button, Card, Empty } from "./ui";

export interface Office {
  id: string;
  slug: string;
  name: string;
  status: string;
  users: number;
  topics: number;
  active_topics: number;
  topic_names: string[];
  /** paket jadwal pengambilan (0029); null = jadwal bawaan owner */
  plan_code?: string | null;
}

/** true = owner platform yang sedang di "rumah" platform (belum memilih kantor) → halaman data perlu pilih kantor dulu. */
export function useNeedsOffice() {
  const { me } = useAuth();
  if (!me?.user.is_platform_operator || getViewAs()) return false;
  return me.tenants.find((t) => t.id === me.current_tenant.id)?.kind === "platform";
}

export function useEnterOffice() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return (o: { id: string; name: string }, to = "/") => {
    setViewAs({ tenantId: o.id, tenantName: o.name, reason: "Pemantauan oleh owner platform" });
    qc.clear();
    nav(to);
  };
}

/** Ditampilkan ke owner platform di halaman data: pilih kantor yang ingin dilihat. */
export function OfficePicker({ to = "/" }: { to?: string }) {
  const q = useQuery({ queryKey: ["tenants"], queryFn: () => api<Office[]>("/admin/tenants") });
  const enter = useEnterOffice();
  return (
    <Card title="Pilih kantor">
      <p className="mb-3 text-sm text-zinc-600">
        Anda owner platform — pilih kantor untuk melihat topik & datanya. Setiap akses tercatat di audit.
      </p>
      {q.data && !q.data.length && <Empty>Belum ada kantor.</Empty>}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {q.data?.map((o) => (
          <div key={o.id} className="flex flex-col rounded-xl border border-zinc-200 p-4">
            <div className="flex items-center gap-2 font-semibold">
              {o.name}
              {o.status !== "active" && <Badge tone="red">dibekukan</Badge>}
            </div>
            <div className="mb-3 flex-1 text-xs text-zinc-500">
              {o.users} user · {o.active_topics} topik aktif{o.topic_names.length ? ` — ${o.topic_names.join(", ")}` : ""}
            </div>
            <Button onClick={() => enter(o, to)}>Masuk ke kantor</Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
