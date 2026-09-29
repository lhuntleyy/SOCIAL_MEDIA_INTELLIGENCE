import { describe, expect, test } from "bun:test";
import { isUuid, TenantId } from "../src";

describe("branded ids", () => {
  test("menerima UUIDv7 dan menormalkan ke lowercase", () => {
    const id = TenantId("0192F0C4-8A4E-7C3B-9D2E-5B1A2F3C4D5E");
    expect(id as string).toBe("0192f0c4-8a4e-7c3b-9d2e-5b1a2f3c4d5e");
  });
  test("menolak string bukan UUID", () => {
    expect(() => TenantId("tenant-1")).toThrow(TypeError);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
