import { z } from "zod";

export const decisionSchema = z.object({
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
      z.object({ type: z.literal("choice"), choice: z.string() }),
    ]),
  ),
});
export type Decision = z.infer<typeof decisionSchema>;

export const scopeAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.enum(["on_topic", "unclear", "off_topic", "abuse"]),
  confidence: z.number().min(0).max(1),
});
export type ScopeAnswer = z.infer<typeof scopeAnswerSchema>;

const answersSchema = z.object({ answers: z.record(z.string(), z.unknown()) });
export const scopeResultSchema = z.union([
  answersSchema,
  z
    .object({ state: z.literal("Completed"), result: answersSchema })
    .transform((value) => value.result),
]);
