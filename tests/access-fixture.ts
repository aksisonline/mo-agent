import { mock } from "bun:test";
import type { AccessService, MoReservation } from "../src/services/access";

export const COOKIE_SECRET = "test-only-visitor-secret-at-least-32-bytes";
let ip = 0;
export function cloudflareRequest(
  request: Request,
  address = `10.${Math.floor(++ip / 65536) % 256}.${Math.floor(ip / 256) % 256}.${ip % 256}`,
) {
  request.headers.set("CF-Connecting-IP", address);
  return Object.assign(request, { cf: { colo: "TEST" } });
}

// Existing personality tests isolate orchestration; memory tests explicitly start with a grant.
export function orchestrationAccess() {
  return {
    reserveMo: mock(async () => ({
      allowed: true as const,
      remaining: 19,
      resetsAt: new Date(Date.now() + 86400000).toISOString(),
      reservationId: crypto.randomUUID(),
    })),
    finishMo: mock(async () => {}),
    claimMoMemory: mock(async () => true),
  } satisfies AccessService;
}

// This models the service contract, not production quota logic. Clock and Asia/Kolkata week
// calculation exist only here: the Worker must forward ACCESS's authoritative metadata.
export class SharedAccess implements AccessService {
  now = Date.parse("2026-10-04T18:29:00Z");
  calls = { reserve: 0, finish: [] as boolean[], claim: 0 };
  private visitors = new Map<
    string,
    {
      week: number;
      used: number;
      turns: Map<string, { id: string; pending: boolean; grant?: number }>;
    }
  >();
  private state(visitor: string) {
    const shifted = new Date(this.now + 19800000);
    const day = (shifted.getUTCDay() + 6) % 7;
    const week =
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - day) -
      19800000;
    let state = this.visitors.get(visitor);
    if (!state || state.week !== week) {
      state = { week, used: 0, turns: new Map() };
      this.visitors.set(visitor, state);
    }
    return state;
  }
  async reserveMo(visitor: string, turn: string): Promise<MoReservation> {
    this.calls.reserve++;
    const state = this.state(visitor);
    const metadata = {
      remaining: Math.max(0, 20 - state.used),
      resetsAt: new Date(state.week + 7 * 86400000).toISOString(),
    };
    if (state.turns.has(turn)) return { allowed: false, reason: "duplicate_turn", ...metadata };
    if ([...state.turns.values()].some((value) => value.pending))
      return { allowed: false, reason: "in_flight", ...metadata };
    if (state.used >= 20) return { allowed: false, reason: "weekly_limit", ...metadata };
    const id = crypto.randomUUID();
    state.used++;
    state.turns.set(turn, { id, pending: true });
    return { allowed: true, ...metadata, remaining: 20 - state.used, reservationId: id };
  }
  async finishMo(visitor: string, turn: string, id: string, succeeded: boolean) {
    this.calls.finish.push(succeeded);
    const state = this.state(visitor);
    const value = state.turns.get(turn);
    if (!value || value.id !== id || !value.pending) return;
    value.pending = false;
    if (succeeded) value.grant = this.now + 600000;
    else state.used--;
  }
  async claimMoMemory(visitor: string, turn: string) {
    this.calls.claim++;
    const value = this.state(visitor).turns.get(turn);
    const allowed = !!value?.grant && value.grant > this.now;
    if (value) value.grant = undefined;
    return allowed;
  }
  expirePending(visitor: string) {
    for (const value of this.state(visitor).turns.values()) value.pending = false;
  }
}
