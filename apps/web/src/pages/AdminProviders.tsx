import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Badge, Button, Card, ErrorText, PLATFORM_LABEL } from "../ui";

interface Connector {
  id: string;
  key: string;
  platform: string;
  runtime: string;
  enabled: boolean;
  provider: { key: string; kind: string; enabled: boolean };
  capabilities: { operation: string; status: string; measured: { p95_latency_ms?: number } }[];
  health: { account_label: string | null; state: string; circuit: string; score: number | null }[];
}

export default function AdminProviders() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-connectors"], queryFn: () => api<Connector[]>("/admin/connectors") });
  const toggle = useMutation({
    mutationFn: (c: Connector) => api(`/admin/connectors/${c.id}`, { method: "PATCH", json: { enabled: !c.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-connectors"] }),
  });
  const probe = useMutation({ mutationFn: (id: string) => api(`/admin/connectors/${id}/health-check`, { method: "POST" }) });
  return (
    <Card title="Provider & connector">
      <ErrorText error={q.error ?? toggle.error ?? probe.error} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-zinc-500">
            <tr>
              <th className="py-2">Connector</th>
              <th>Platform</th>
              <th>Provider</th>
              <th>Capability</th>
              <th>Health</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {q.data?.map((c) => (
              <tr key={c.id}>
                <td className="py-2 font-mono text-xs">{c.key}</td>
                <td>{PLATFORM_LABEL[c.platform] ?? c.platform}</td>
                <td>
                  {c.provider.key}{" "}
                  <Badge tone={c.provider.kind === "unofficial" ? "red" : c.provider.kind === "official" ? "blue" : "zinc"}>
                    {c.provider.kind}
                  </Badge>
                </td>
                <td className="space-x-1">
                  {c.capabilities.map((k) => (
                    <Badge key={k.operation} tone={k.status === "verified" ? "green" : k.status === "failed" ? "red" : "zinc"}>
                      {k.operation}
                    </Badge>
                  ))}
                </td>
                <td className="space-x-1">
                  {c.health.length ? (
                    c.health.map((h) => (
                      <Badge key={`${h.account_label}`} tone={h.circuit === "closed" ? "green" : "red"}>
                        {h.circuit}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-zinc-400">—</span>
                  )}
                </td>
                <td className="space-x-2 whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => probe.mutate(c.id)}>
                    Cek
                  </Button>
                  <Button variant={c.enabled ? "danger" : "primary"} onClick={() => toggle.mutate(c)} disabled={toggle.isPending}>
                    {c.enabled ? "Nonaktifkan" : "Aktifkan"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
