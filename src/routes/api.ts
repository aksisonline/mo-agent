import { inputSchema } from "../schemas/conversation";
import { cooledAgentState } from "../lib/agent-state";
import { jsonHeaders, readJsonBody } from "../lib/http";
import { chat } from "../services/chat";
import { updateMemory } from "../services/memory";
import { accessService, finishReservation, reservationSchema } from "../services/access";
import type { AccessService, MoReservation } from "../services/access";
import { visitorIdentity } from "../lib/visitor";
import { burstKey, createIpBurstLimiter } from "../lib/ip-burst";
import { completedMoStream } from "../lib/mo-stream";
import { selectScopeReply } from "../lib/scope-replies";

export const WEEKLY_LIMIT_MESSAGE =
  "Mo. has a limit of 20 chats per week. Please return after the reset.";
const ipBurst = createIpBurstLimiter();

export async function routeRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  let agentState = cooledAgentState();
  let cookie: string | undefined;
  let reservation: MoReservation | undefined;
  let access: AccessService;
  let visitorId: string;
  let reservedTurn: string | undefined;
  const finish = (response: Response) => {
    response.headers.set("Cache-Control", "no-store");
    if (cookie) response.headers.set("Set-Cookie", cookie);
    if (reservation) {
      response.headers.set("X-Mo-Remaining", String(reservation.remaining));
      response.headers.set("X-Mo-Resets-At", reservation.resetsAt);
    }
    if (path === "/api/chat") {
      response.headers.set("X-Agent-State", JSON.stringify(agentState));
      response.headers.set("Cache-Control", "no-store");
    }
    return response;
  };
  if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });
  if (path === "/api/health")
    return Response.json({ ok: true, model: env.OLLAMA_MODEL }, { headers: jsonHeaders });
  if (!["/api/chat", "/api/memory"].includes(path))
    return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return finish(new Response("Method not allowed", { status: 405 }));
  const burstAllowed = ipBurst(burstKey(request));
  try {
    const identity = await visitorIdentity(request, env);
    visitorId = identity.visitorId;
    cookie = identity.cookie;
  } catch {
    return finish(Response.json({ error: "Mo. access is unavailable" }, { status: 503 }));
  }
  if (!burstAllowed)
    return finish(
      Response.json({ error: "Too many attempts. Please wait a minute." }, { status: 429 }),
    );
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return finish(new Response("Origin rejected", { status: 403 }));
  try {
    const body = await readJsonBody(request);
    if (body.error) return finish(body.error);
    const parsed = inputSchema.safeParse(body.raw);
    if (!parsed.success)
      return finish(Response.json({ error: "Invalid conversation input" }, { status: 400 }));
    const input = parsed.data;
    agentState = cooledAgentState(input.agentState);
    try {
      access = accessService(env);
      if (path === "/api/memory") {
        const claimed: unknown = await access.claimMoMemory(visitorId, input.turnId);
        if (typeof claimed !== "boolean") throw new Error("Invalid memory claim");
        if (!claimed)
          return finish(
            Response.json(
              { error: "No completed chat memory grant is available" },
              { status: 403 },
            ),
          );
      } else {
        reservation = reservationSchema.parse(await access.reserveMo(visitorId, input.turnId));
        if (!reservation.allowed) {
          const status = ["weekly_limit", "rate_limit"].includes(reservation.reason) ? 429 : 409;
          return finish(
            Response.json(
              {
                error:
                  reservation.reason === "weekly_limit"
                    ? WEEKLY_LIMIT_MESSAGE
                    : "Mo. cannot accept this turn yet.",
                reason: reservation.reason,
                remaining: reservation.remaining,
                resetsAt: reservation.resetsAt,
              },
              { status },
            ),
          );
        }
        reservedTurn = input.turnId;
      }
    } catch {
      console.warn(JSON.stringify({ event: "access_unavailable" }));
      return finish(Response.json({ error: "Mo. access is unavailable" }, { status: 503 }));
    }
    if (path === "/api/memory")
      return finish(Response.json(await updateMemory(input, env), { headers: jsonHeaders }));
    const result = await chat(input, env, (state) => {
      agentState = state;
    });
    const { scope, policy, memoryAllowed } = result;
    const content = selectScopeReply(scope, result.boundary, input.messages);
    if (!reservation?.allowed) throw new Error("Missing reservation");
    if (memoryAllowed && !result.body) throw new Error("Missing provider body");
    const reservationId = reservation.reservationId;
    if (result.providerFailed)
      await finishReservation(access, visitorId, input.turnId, reservationId, false);
    const complete = async () => {
      if (!result.providerFailed)
        await finishReservation(access, visitorId, input.turnId, reservationId, true);
    };
    // Fixed replies follow the same done + EOF lifecycle; cancellation cannot grant memory.
    const upstream = memoryAllowed
      ? result.body!
      : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ message: { role: "assistant", content }, done: true }) + "\n",
              ),
            );
            controller.close();
          },
        });
    const responseBody = completedMoStream(upstream, complete);
    reservedTurn = undefined; // Once returned, stream failures remain pending and conservatively charged.
    return finish(
      new Response(responseBody, {
        headers: {
          "Content-Type": "application/x-ndjson",
          ...jsonHeaders,
          "X-Agent-Policy": JSON.stringify({ ...policy, scope, memoryAllowed }),
        },
      }),
    );
  } catch {
    if (reservedTurn && reservation?.allowed)
      await finishReservation(access!, visitorId!, reservedTurn, reservation.reservationId, false);
    // Errors from providers and schema validation may contain user content. Log only the event.
    console.error(JSON.stringify({ event: "pipeline_error" }));
    return finish(
      Response.json(
        {
          error:
            "The AI service could not complete this request. Check Workers AI access and the Ollama connection.",
        },
        { status: 502, headers: jsonHeaders },
      ),
    );
  }
}
