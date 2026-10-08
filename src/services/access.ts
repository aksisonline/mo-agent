import { z } from "zod";

// Internal RPC contract only; generated Env remains owned by Wrangler.
export interface AccessService {
  reserveMo(visitorId: string, turnId: string): Promise<MoReservation>;
  finishMo(
    visitorId: string,
    turnId: string,
    reservationId: string,
    succeeded: boolean,
  ): Promise<void>;
  claimMoMemory(visitorId: string, turnId: string): Promise<boolean>;
}
export const reservationSchema = z.discriminatedUnion("allowed", [
  z
    .object({
      allowed: z.literal(true),
      remaining: z.number().int().min(0).max(20),
      // ACCESS supplies an ISO 8601 UTC string; preserve its authoritative week boundary.
      resetsAt: z.iso.datetime(),
      reservationId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      allowed: z.literal(false),
      reason: z.enum(["weekly_limit", "rate_limit", "in_flight", "duplicate_turn"]),
      remaining: z.number().int().min(0).max(20),
      resetsAt: z.iso.datetime(),
    })
    .strict(),
]);
export type MoReservation = z.infer<typeof reservationSchema>;

export function accessService(env: Env): AccessService {
  if ("MO_QUOTAS" in env && env.MO_QUOTAS) {
    const visitor = (id: string) => env.MO_QUOTAS.getByName(id.toLowerCase());
    return {
      reserveMo: async (id, turn) =>
        reservationSchema.parse(await visitor(id).reserve(turn.toLowerCase())),
      finishMo: async (id, turn, reservation, succeeded) => {
        await visitor(id).finish(turn.toLowerCase(), reservation, succeeded);
      },
      claimMoMemory: async (id, turn) => visitor(id).claimMemory(turn.toLowerCase()),
    };
  }
  const binding: unknown = "ACCESS" in env ? env.ACCESS : undefined;
  if (!binding || (typeof binding !== "object" && typeof binding !== "function"))
    throw new Error("Access unavailable");
  // RPC stubs can synthesize methods on access without exposing them to the `in` operator.
  const methods = binding as Partial<AccessService>;
  if (
    typeof methods.reserveMo !== "function" ||
    typeof methods.finishMo !== "function" ||
    typeof methods.claimMoMemory !== "function"
  )
    throw new Error("Access unavailable");
  // Validate methods structurally and validate every untrusted RPC result at its call site.
  return methods as AccessService;
}

export async function finishReservation(
  access: AccessService,
  visitorId: string,
  turnId: string,
  reservationId: string,
  succeeded: boolean,
) {
  try {
    await access.finishMo(visitorId, turnId, reservationId, succeeded);
  } catch {
    // Never refund or fabricate a memory grant when ACCESS cannot acknowledge completion.
    console.warn(JSON.stringify({ event: "access_finish_unavailable" }));
  }
}
