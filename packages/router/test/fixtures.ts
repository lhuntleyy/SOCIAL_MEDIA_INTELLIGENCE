// Fixture snapshot buatan tangan untuk test router (select + reserve).
import type { RouteInput } from "@smip/core";
import { type Account, type ConnectorInfo, type Policy, policyKey, type Rule, type Snapshot } from "../src";

export const T_A = "0192f000-0000-7000-8000-00000000000a";
export const T_B = "0192f000-0000-7000-8000-00000000000b";

export function connector(
  key: string,
  o: Partial<ConnectorInfo> & { status?: "declared" | "verified" | "failed"; minInterval?: number; cost?: number } = {},
): ConnectorInfo {
  return {
    id: `c-${key}`,
    key,
    providerId: `p-${key}`,
    providerEnabled: true,
    platform: "x",
    runtime: "bun",
    enabled: true,
    capabilities: new Map([
      [
        "search_keyword",
        {
          status: o.status ?? "verified",
          queryFeatures: ["term", "phrase"],
          measured: { minIntervalSec: o.minInterval, costPer1kResults: o.cost },
        },
      ],
    ]),
    ...o,
  };
}
export const rule = (key: string, priority: number, weight: number, o: Partial<Rule> = {}): Rule => ({
  id: `r-${key}`,
  connectorId: `c-${key}`,
  priority,
  weight,
  enabled: true,
  maxSharePct: null,
  runKinds: null,
  ...o,
});
export const account = (key: string, o: Partial<Account> = {}): Account => ({
  id: `a-${key}${o.tenantId ? `-${o.tenantId.slice(-1)}` : ""}`,
  tenantId: null,
  providerId: `p-${key}`,
  label: key,
  status: "active",
  cooldownUntil: null,
  allowedConnectorIds: null,
  ...o,
});

export function snapshot(
  conns: ConnectorInfo[],
  rules: Rule[],
  o: Partial<Policy> & { accounts?: Account[]; extra?: Policy[] } = {},
): Snapshot {
  const policy: Policy = {
    id: "pol-global",
    tenantId: null,
    platform: "x",
    operation: "search_keyword",
    strategy: "priority_weighted",
    failoverEnabled: true,
    maxAttempts: 3,
    allowUnverified: false,
    enabled: true,
    version: 1,
    rules,
    ...o,
  };
  const accounts = o.accounts ?? conns.map((c) => account(c.key));
  const byProv = new Map<string, Account[]>();
  for (const a of accounts) byProv.set(a.providerId, [...(byProv.get(a.providerId) ?? []), a]);
  const policies = new Map([[policyKey(policy.tenantId, policy.platform, policy.operation), policy]]);
  for (const p of o.extra ?? []) policies.set(policyKey(p.tenantId, p.platform, p.operation), p);
  return {
    version: 1,
    loadedAt: new Date(),
    policies,
    connectors: new Map(conns.map((c) => [c.id, c])),
    accountsByProvider: byProv,
    rateLimits: new Map(),
    quotas: new Map(),
  };
}

export const input = (o: Partial<RouteInput> = {}): RouteInput => ({
  tenantId: T_A,
  platform: "x",
  operation: "search_keyword",
  runKind: "incremental",
  requiredFeatures: ["term"],
  intervalSec: 300,
  excludeConnectorIds: [],
  excludeAccountIds: [],
  estimatedUnits: { requests: 1, results: 20 },
  ...o,
});
