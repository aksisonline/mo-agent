import { expect, test } from "bun:test";
import { SCOPE_REPLY_POOLS, selectScopeReply } from "../src/lib/scope-replies";
import type { ConversationInput } from "../src/schemas/conversation";

const categories = ["off_topic", "unclear", "abuse", "boundary"] as const;
const assistantMessages = (replies: readonly string[]): ConversationInput["messages"] =>
  replies.map((content) => ({ role: "assistant", content }));
const select = (category: (typeof categories)[number], messages: ConversationInput["messages"]) =>
  selectScopeReply(
    category === "boundary" ? "on_topic" : category,
    category === "boundary",
    messages,
  );

test("server-owned pools are bounded, concise, unique, and use the owner's name", () => {
  const replies = Object.values(SCOPE_REPLY_POOLS).flat();
  expect(new Set(replies).size).toBe(replies.length);
  for (const category of categories) {
    expect(SCOPE_REPLY_POOLS[category]).toHaveLength(10);
    for (const reply of SCOPE_REPLY_POOLS[category]) {
      expect(reply).toContain("the portfolio owner");
      expect(reply).not.toContain("the owner");
      expect(reply).not.toContain("I'm Mo");
      expect(reply.length).toBeLessThanOrEqual(180);
    }
  }
});

for (const category of categories) {
  test(`${category} selects only from its pool with no recent messages`, () => {
    for (let attempt = 0; attempt < 20; attempt++)
      expect<readonly string[]>(SCOPE_REPLY_POOLS[category]).toContain(select(category, []));
  });

  test(`${category} avoids every exact recent assistant reply when alternatives remain`, () => {
    const pool = SCOPE_REPLY_POOLS[category];
    const messages = assistantMessages(pool.slice(0, -2));
    const unused: readonly string[] = pool.slice(-2);
    for (let attempt = 0; attempt < 20; attempt++)
      expect(unused).toContain(select(category, messages));
    // Each alternative can be reached, without relying on probabilistic test outcomes.
    for (const remaining of pool) {
      const history = assistantMessages(pool.filter((reply) => reply !== remaining));
      expect(select(category, history)).toBe(remaining);
      expect(select(category, history)).toBe(remaining);
    }
  });

  test(`${category} falls back to its own pool when all replies have been used`, () => {
    const messages = assistantMessages(SCOPE_REPLY_POOLS[category]);
    const original = structuredClone(messages);
    for (let attempt = 0; attempt < 20; attempt++)
      expect<readonly string[]>(SCOPE_REPLY_POOLS[category]).toContain(select(category, messages));
    expect(messages).toEqual(original);
  });

  test(`${category} ignores user echoes and matches assistant content exactly`, () => {
    const pool = SCOPE_REPLY_POOLS[category];
    const remaining = pool[0];
    const messages = assistantMessages(pool.slice(1));
    messages.push({ role: "user", content: remaining });
    messages.push({ role: "assistant", content: `${remaining} ` });
    expect(select(category, messages)).toBe(remaining);
  });
}

test("boundary takes precedence over every scope and uses boundary history for anti-repeat", () => {
  const pool = SCOPE_REPLY_POOLS.boundary;
  const messages = assistantMessages(pool.slice(1));
  for (const scope of ["on_topic", "off_topic", "unclear", "abuse"] as const)
    expect(selectScopeReply(scope, true, messages)).toBe(pool[0]);
});

test("unclear replies remain clarification requests rather than accusations or provider diagnoses", () => {
  for (const reply of SCOPE_REPLY_POOLS.unclear) {
    expect(reply).toMatch(/\?|[Pp]lease/);
    expect(reply).not.toMatch(/abuse|override|unrelated|provider|unavailable|failure/i);
  }
});

test("abuse replies set safe boundaries while offering a portfolio path forward", () => {
  for (const reply of SCOPE_REPLY_POOLS.abuse) {
    expect(reply).toMatch(/won't|can't|aren't|[Pp]lease|not comply/);
    expect(reply).not.toMatch(/apologi|idiot|stupid|punish|ban/i);
  }
});
