// Re-export DTO snapshot dari core (dimuat oleh adapter DB, lihat @smip/db loadRoutingSnapshot).
export type {
  Account,
  Capability,
  CapabilityStatus,
  ConnectorInfo,
  Policy,
  RoutingSnapshot as Snapshot,
  Rule,
} from "@smip/core";
export { GLOBAL, policyKey } from "@smip/core";
