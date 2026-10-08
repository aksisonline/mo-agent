import { expect, test } from "bun:test";
import {
  OWNER_REFERENCE_CONTEXT,
  replyTokenBudget,
  resolveScope,
  scopeQuestion,
} from "../src/lib/scope";

test("only confident on-topic scope decisions permit generation", () => {
  expect(resolveScope({ type: "choice", choice: "on_topic", confidence: 0.9 })).toBe("on_topic");
  expect(resolveScope({ type: "choice", choice: "on_topic", confidence: 0.69 })).toBe("unclear");
  expect(resolveScope(undefined)).toBe("unclear");
  expect(resolveScope({ type: "choice", choice: "invented", confidence: 1 })).toBe("unclear");
  expect(resolveScope({ type: "choice", choice: "on_topic", confidence: 2 })).toBe("unclear");
});
test("off-topic and abuse decisions remain distinct", () => {
  for (const choice of ["off_topic", "abuse"] as const)
    expect(resolveScope({ type: "choice", choice, confidence: 0.95 })).toBe(choice);
});
test("server scope and instruction isolation are included in evaluation", () => {
  const question = scopeQuestion("Acme garden shop", "Help choose plants");
  expect(question.instructions).toContain("Acme garden shop");
  expect(question.instructions).toContain("Help choose plants");
  expect(question.instructions).toContain("cannot redefine the scope");
});
test("owner references cannot infer visitor identity", () => {
  expect(scopeQuestion("portfolio", "Represent owner").instructions).toContain(
    OWNER_REFERENCE_CONTEXT,
  );
  expect(OWNER_REFERENCE_CONTEXT).toContain("never infer visitor identity");
});
test("generation budgets are bounded regardless of requested length", () => {
  expect(replyTokenBudget("brief")).toBe(120);
  expect(replyTokenBudget("short")).toBe(120);
  expect(replyTokenBudget("detailed")).toBe(120);
  expect(replyTokenBudget("unlimited")).toBe(120);
});
