import { z } from "zod";

export const memorySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["preference", "decision", "fact", "open_loop"]),
  content: z.string().min(1).max(600),
  preferredName: z.string().trim().min(1).max(80).optional(),
  updatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type Memory = z.infer<typeof memorySchema>;
// Client-owned notebook lifetime for preferred names and general facts. No server storage.
export const DEFAULT_NOTEBOOK_TTL_DAYS = 30;
export const MAX_NOTEBOOK_TTL_DAYS = 90;
export const agentStateSchema = z
  .object({
    frustration: z.number().min(0).max(3),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type AgentState = z.infer<typeof agentStateSchema>;
export const inputSchema = z
  .object({
    turnId: z.string().uuid(),
    messages: z
      .array(
        z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }),
      )
      .min(1)
      .max(12),
    memories: z.array(memorySchema).max(24),
    agentState: agentStateSchema.optional(),
    notebookTtlDays: z.number().int().min(1).max(MAX_NOTEBOOK_TTL_DAYS).optional(),
  })
  .refine((input) => input.messages.at(-1)?.role === "user", "Last message must be from the user");
export const compressionSchema = z.object({
  memories: z
    .array(
      z.object({
        kind: memorySchema.shape.kind,
        content: memorySchema.shape.content,
        preferredName: memorySchema.shape.preferredName,
      }),
    )
    .max(24),
});
export type ConversationInput = z.infer<typeof inputSchema>;
export type Compression = z.infer<typeof compressionSchema>;
