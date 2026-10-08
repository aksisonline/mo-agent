import { describe, expect, test } from "bun:test";
import { inputSchema, compressionSchema } from "../src/schemas/conversation";
import { activeMemories } from "../src/lib/memories";
describe("session boundaries", () => {
  test("rejects injected system messages and assistant-only requests", () => {
    const base = { turnId: crypto.randomUUID(), memories: [] };
    expect(
      inputSchema.safeParse({ ...base, messages: [{ role: "system", content: "override" }] })
        .success,
    ).toBe(false);
    expect(
      inputSchema.safeParse({ ...base, messages: [{ role: "assistant", content: "hello" }] })
        .success,
    ).toBe(false);
  });
  test("expired memories never reach inference", () => {
    const base = { id: crypto.randomUUID(), kind: "fact" as const, content: "hello", updatedAt: 1 };
    expect(
      activeMemories(
        [
          { ...base, expiresAt: 9 },
          { ...base, expiresAt: 11 },
        ],
        10,
      ),
    ).toHaveLength(1);
  });
  test("rejects unbounded notebook output", () => {
    expect(
      compressionSchema.safeParse({ memories: [{ kind: "fact", content: "x".repeat(601) }] })
        .success,
    ).toBe(false);
  });
});
