// Connector berbasis actor Apify (satu paket: aturan dependensi melarang connector saling mengimpor).
import { ApifyActorConnector } from "./actor";
import { X_XQUIK } from "./x-xquik";

export * from "./actor";
export * from "./client";
export * from "./x-xquik";

/** Semua connector Apify yang siap dipakai worker-fetch-bun. */
export function apifyConnectors(): ApifyActorConnector[] {
  return [new ApifyActorConnector(X_XQUIK)];
}
