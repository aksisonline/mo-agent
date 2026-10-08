import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { routeRequest } from "../src/routes/api";
const worker = { fetch: routeRequest };
import { SharedAccess, COOKIE_SECRET, cloudflareRequest } from "./access-fixture";
import { burstKey, createIpBurstLimiter } from "../src/lib/ip-burst";
import { visitorIdentity, VISITOR_COOKIE_MAX_AGE_SECONDS } from "../src/lib/visitor";
import { MAX_NDJSON_LINE_BYTES } from "../src/lib/mo-stream";
import { reservationSchema } from "../src/services/access";
import { SCOPE_REPLY_POOLS } from "../src/lib/scope-replies";

const conversation = () => ({
  turnId: crypto.randomUUID(),
  messages: [{ role: "user", content: "Hello Mo" }],
  memories: [],
});
function setup(onTopic = false) {
  const access = new SharedAccess();
  const run = mock(async () => ({
    answers: {
      scope: { type: "choice", choice: onTopic ? "on_topic" : "off_topic", confidence: 1 },
      update: { type: "noul", noul: 1 },
    },
  }));
  const env = {
    ACCESS: access,
    VISITOR_COOKIE_SECRET: COOKIE_SECRET,
    AI: { run },
    OLLAMA_BASE_URL: "https://ollama.example",
    OLLAMA_MODEL: "chat",
    MEMORY_MODEL: "memory",
    WEBSITE_CONTEXT: "the owner portfolio",
    AGENT_INTENT: "Represent the owner",
  } as unknown as Env;
  return { env, access, run };
}
function request(body = conversation(), cookie?: string, path = "/api/chat", ip?: string) {
  return cloudflareRequest(
    new Request(`https://portfolio.example${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: cookie ? { Cookie: cookie } : {},
    }),
    ip,
  );
}
const cookieFrom = (response: Response) => response.headers.get("Set-Cookie")!.split(";")[0];
async function identity(env: Env) {
  const value = await visitorIdentity(request(), env);
  return { id: value.visitorId, cookie: value.cookie!.split(";")[0] };
}
afterEach(() => mock.restore());

test("reservation reset timestamps require ISO 8601 UTC strings without conversion", () => {
  const reservation = { allowed: true, remaining: 19, reservationId: crypto.randomUUID() };
  const resetsAt = "2026-10-04T18:30:00.000Z";
  expect(reservationSchema.parse({ ...reservation, resetsAt }).resetsAt).toBe(resetsAt);
  for (const invalid of [
    Date.parse(resetsAt),
    "not-a-date",
    "2026-02-30T18:30:00.000Z",
    "2026-10-05T00:00:00.000+05:30",
  ]) {
    expect(reservationSchema.safeParse({ ...reservation, resetsAt: invalid }).success).toBe(false);
    expect(
      reservationSchema.safeParse({
        allowed: false,
        reason: "weekly_limit",
        remaining: 0,
        resetsAt: invalid,
      }).success,
    ).toBe(false);
  }
});

test("ACCESS shared visitor quota: 20/21, duplicate, metadata and Monday Kolkata reset", async () => {
  const { env, access, run } = setup();
  const { cookie } = await identity(env);
  const firstTurn = conversation();
  const first = await worker.fetch(request(firstTurn, cookie), env);
  await first.text();
  expect(first.headers.get("X-Mo-Remaining")).toBe("19");
  expect(first.headers.get("X-Mo-Resets-At")).toBe("2026-10-04T18:30:00.000Z");
  const duplicate = await worker.fetch(request(firstTurn, cookie), env);
  expect(duplicate.status).toBe(409);
  expect(((await duplicate.json()) as { reason: string }).reason).toBe("duplicate_turn");
  for (let n = 1; n < 20; n++) {
    const response = await worker.fetch(request(conversation(), cookie), env);
    expect(response.status).toBe(200);
    await response.text();
  }
  const denied = await worker.fetch(request(conversation(), cookie), env);
  expect(denied.status).toBe(429);
  expect(denied.headers.get("X-Agent-State")).not.toBeNull();
  expect((await denied.json()) as unknown).toEqual({
    error: expect.stringMatching(/Mo.*20.*reset/),
    reason: "weekly_limit",
    remaining: 0,
    resetsAt: "2026-10-04T18:30:00.000Z",
  });
  expect(run).toHaveBeenCalledTimes(20);
  access.now = Date.parse("2026-10-04T18:30:00Z");
  const reset = await worker.fetch(request(conversation(), cookie), env);
  expect(reset.status).toBe(200);
  expect(reset.headers.get("X-Mo-Remaining")).toBe("19");
});

test("fixed scope and cooldown replies stay pending until done and EOF are consumed", async () => {
  const upstream = spyOn(globalThis, "fetch");
  for (const cooldown of [false, true]) {
    const { env, access, run } = setup(cooldown);
    const { cookie, id } = await identity(env);
    const turn = cooldown
      ? Object.assign(conversation(), {
          messages: [{ role: "user", content: "Continue." }],
          agentState: { frustration: 3, updatedAt: Date.now() + 1000 },
        })
      : conversation();
    const response = await worker.fetch(request(turn, cookie), env);
    expect(response.status).toBe(200);
    expect(access.calls.finish).toEqual([]);
    expect((await worker.fetch(request(turn, cookie, "/api/memory"), env)).status).toBe(403);
    expect((await worker.fetch(request(conversation(), cookie), env)).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    const record = JSON.parse(new TextDecoder().decode(chunk.value));
    expect(record.done).toBe(true);
    expect(SCOPE_REPLY_POOLS[cooldown ? "boundary" : "off_topic"]).toContain(
      record.message.content,
    );
    expect(access.calls.finish).toEqual([]);
    expect(await access.claimMoMemory(id, turn.turnId)).toBe(false);
    expect((await reader.read()).done).toBe(true);
    expect(access.calls.finish).toEqual([true]);
    expect(await access.claimMoMemory(id, turn.turnId)).toBe(true);
  }
  expect(upstream).not.toHaveBeenCalled();
});

test("cancelling fixed replies before consumption or after done leaves pending without memory", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  for (const readDone of [false, true]) {
    const { env, access } = setup();
    const { cookie, id } = await identity(env);
    const turn = conversation();
    const response = await worker.fetch(request(turn, cookie), env);
    const reader = response.body!.getReader();
    if (readDone) expect((await reader.read()).done).toBe(false);
    await reader.cancel("client gone");
    expect(access.calls.finish).toEqual([]);
    expect(await access.claimMoMemory(id, turn.turnId)).toBe(false);
    expect((await worker.fetch(request(conversation(), cookie), env)).status).toBe(409);
  }
});

test("RPC binding methods are inspected by access, not property-existence checks", async () => {
  const { env, access } = setup();
  const stub = new Proxy(access, {
    has() {
      throw new Error("RPC stub does not support property-existence checks");
    },
    get(target, property) {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Object.assign(env, { ACCESS: stub });
  const response = await worker.fetch(request(), env);
  expect(response.status).toBe(200);
  await response.text();
  expect(access.calls.reserve).toBe(1);
  expect(access.calls.finish).toEqual([true]);
});

test("pending chat denies concurrent and duplicate turns before any provider", async () => {
  const { env, run, access } = setup(true);
  const { cookie, id } = await identity(env);
  const turn = conversation();
  const stream = new ReadableStream<Uint8Array>();
  const upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
  const first = await worker.fetch(request(turn, cookie), env);
  expect((await worker.fetch(request(turn, cookie), env)).status).toBe(409);
  expect((await worker.fetch(request(conversation(), cookie), env)).status).toBe(409);
  expect(run).toHaveBeenCalledTimes(1);
  expect(upstream).toHaveBeenCalledTimes(1);
  await first.body!.cancel();
  expect(stream.locked).toBe(false);
  expect(access.calls.finish).toEqual([]);
  expect(await access.claimMoMemory(id, turn.turnId)).toBe(false);
  access.expirePending(id);
  const next = await access.reserveMo(id, crypto.randomUUID());
  expect(next.remaining).toBe(18); // Expired pending remained charged.
});

test("bad signatures, unsigned UUID, duplicate/oversized cookies create fresh identity; no header identity", async () => {
  const { env } = setup();
  const original = await identity(env);
  const tampered = original.cookie.slice(0, -1) + (original.cookie.endsWith("a") ? "b" : "a");
  for (const cookie of [
    tampered,
    `__Host-mo-visitor=${original.id}`,
    `${original.cookie}; ${original.cookie}`,
    `other=${"x".repeat(9000)}`,
  ]) {
    const req = request(conversation(), cookie);
    req.headers.set("X-Visitor-Id", original.id);
    const fresh = await visitorIdentity(req, env);
    expect(fresh.visitorId).not.toBe(original.id);
    expect(fresh.cookie).toContain("; HttpOnly; SameSite=Lax; Secure");
    expect(fresh.cookie).not.toContain("Domain=");
  }
  expect((await visitorIdentity(request(conversation(), original.cookie), env)).visitorId).toBe(
    original.id,
  );
  const replacement = await worker.fetch(request(conversation(), tampered), env);
  expect(cookieFrom(replacement)).not.toBe(original.cookie);
  expect(VISITOR_COOKIE_MAX_AGE_SECONDS).toBe(90 * 86400);
});

test("secrets and unknown/unavailable/malformed RPC fail closed without providers; blocked responses set cookies", async () => {
  const upstream = spyOn(globalThis, "fetch");
  spyOn(console, "warn").mockImplementation(() => {});
  for (const overrides of [
    { VISITOR_COOKIE_SECRET: undefined },
    { VISITOR_COOKIE_SECRET: "short" },
    { ACCESS: undefined },
    { ACCESS: { fetch: async () => new Response() } },
    {
      ACCESS: {
        reserveMo: async () => {
          throw new Error("secret transcript");
        },
        finishMo: async () => {},
        claimMoMemory: async () => false,
      },
    },
    {
      ACCESS: {
        reserveMo: async () => ({
          allowed: true,
          remaining: 19,
          resetsAt: "2026-10-04T18:30:00.000Z",
        }),
        finishMo: async () => {},
        claimMoMemory: async () => false,
      },
    },
    {
      ACCESS: {
        reserveMo: async () => ({
          allowed: false,
          reason: "weekly_limit",
          remaining: 0,
          resetsAt: "2026-10-04T18:30:00.000Z",
          reservationId: crypto.randomUUID(),
        }),
        finishMo: async () => {},
        claimMoMemory: async () => false,
      },
    },
  ]) {
    const { env, run } = setup();
    Object.assign(env, overrides);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Agent-State")).not.toBeNull();
    expect(run).not.toHaveBeenCalled();
    if (!Object.hasOwn(overrides, "VISITOR_COOKIE_SECRET"))
      expect(response.headers.get("Set-Cookie")).not.toBeNull();
  }
  expect(upstream).not.toHaveBeenCalled();
  const { env, run } = setup();
  Object.assign(env, {
    ACCESS: {
      reserveMo: async () => ({}),
      finishMo: async () => {},
      claimMoMemory: async () => "true",
    },
  });
  expect((await worker.fetch(request(conversation(), undefined, "/api/memory"), env)).status).toBe(
    503,
  );
  expect(run).not.toHaveBeenCalled();
});

test("30 rolling-minute attempts shared across chat/memory before schema, with bounded fail-closed keys", async () => {
  const { env, run, access } = setup();
  for (let n = 0; n < 30; n++) {
    const req = request(
      conversation(),
      undefined,
      n % 2 ? "/api/chat" : "/api/memory",
      "192.0.2.10",
    );
    const malformed = cloudflareRequest(
      new Request(req.url, { method: "POST", body: "{" }),
      "192.0.2.10",
    );
    expect((await worker.fetch(malformed, env)).status).toBe(400);
  }
  for (const path of ["/api/chat", "/api/memory"]) {
    const blocked = await worker.fetch(request(conversation(), undefined, path, "192.0.2.10"), env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Set-Cookie")).not.toBeNull();
  }
  expect(run).not.toHaveBeenCalled();
  expect(access.calls.reserve).toBe(0);
  let now = 0;
  const limit = createIpBurstLimiter(() => now, 1);
  for (let i = 0; i < 30; i++) expect(limit("one")).toBe(true);
  expect(limit("one")).toBe(false);
  expect(limit("two")).toBe(false);
  now = 60000;
  expect(limit("two")).toBe(true);
  const direct = new Request("https://portfolio.example/api/chat", {
    headers: { "CF-Connecting-IP": "192.0.2.1", "X-Forwarded-For": "192.0.2.2" },
  });
  expect(burstKey(direct)).toBe("anonymous");
  expect(burstKey(cloudflareRequest(new Request(direct), "not-an-ip"))).toBe("anonymous");
  expect(burstKey(cloudflareRequest(new Request(direct), "2001:0db8:0:0:0:0:0:1"))).toBe(
    "[2001:db8::1]",
  );
});

test("pre-response failure refunds; finish failure is conservative with event-only logs", async () => {
  const { env, access } = setup(true);
  const { cookie, id } = await identity(env);
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider failed"));
  expect((await worker.fetch(request(conversation(), cookie), env)).status).toBe(502);
  expect(access.calls.finish).toEqual([false]);
  expect((await access.reserveMo(id, crypto.randomUUID())).remaining).toBe(19);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const second = setup();
  second.access.finishMo = async () => {
    throw new Error("private name");
  };
  const response = await worker.fetch(request(), second.env);
  expect(response.status).toBe(200);
  await response.text(); // Completion RPC failure must not hang or reject response consumption.
  expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "access_finish_unavailable" }));
});

test("done record plus clean EOF completes once, releases lock, and memory grant is consumed on inference failure", async () => {
  const { env, access, run } = setup(true);
  const { cookie, id } = await identity(env);
  const turn = conversation();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"message":{"content":"Hi"},"done":false}\n{"do'));
      c.enqueue(new TextEncoder().encode('ne":true}'));
      c.close();
    },
  });
  spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
  const response = await worker.fetch(request(turn, cookie), env);
  expect(access.calls.finish).toEqual([]);
  expect(await response.text()).toContain('ne":true}');
  expect(stream.locked).toBe(false);
  expect(access.calls.finish).toEqual([true]);
  run.mockRejectedValue(new Error("JEV failure"));
  spyOn(console, "error").mockImplementation(() => {});
  expect((await worker.fetch(request(turn, cookie, "/api/memory"), env)).status).toBe(502);
  const calls = run.mock.calls.length;
  expect((await worker.fetch(request(turn, cookie, "/api/memory"), env)).status).toBe(403);
  expect(run.mock.calls.length).toBe(calls);
  expect(await access.claimMoMemory(id, turn.turnId)).toBe(false);
});

test("midstream error, EOF without done, invalid/oversized NDJSON and cancellation never finish or grant", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  for (const variant of ["error", "eof", "oversized", "invalid", "cancel"] as const) {
    const { env, access } = setup(true);
    const { cookie, id } = await identity(env);
    const turn = conversation();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    const response = await worker.fetch(request(turn, cookie), env);
    const reader = response.body!.getReader();
    if (variant === "cancel") await reader.cancel("client gone");
    else {
      controller.enqueue(new TextEncoder().encode('{"done":false}\n'));
      expect((await reader.read()).done).toBe(false);
      if (variant === "error") {
        controller.error(new Error("interrupted"));
        await expect(reader.read()).rejects.toThrow();
      }
      if (variant === "eof") {
        controller.close();
        expect((await reader.read()).done).toBe(true);
      }
      if (variant === "oversized" || variant === "invalid") {
        controller.enqueue(
          new TextEncoder().encode(
            variant === "oversized"
              ? "x".repeat(MAX_NDJSON_LINE_BYTES + 1)
              : '{"done":true,"error":"failed"}\n',
          ),
        );
        await expect(reader.read()).rejects.toThrow();
      }
    }
    expect(stream.locked).toBe(false);
    if (variant === "cancel" || variant === "oversized" || variant === "invalid")
      expect(cancelled).toBe(true);
    expect(access.calls.finish).toEqual([]);
    expect(await access.claimMoMemory(id, turn.turnId)).toBe(false);
  }
});

test("memory cannot replay old visitor grant after tampering; grant expires after ten minutes", async () => {
  const { env, access, run } = setup();
  const { cookie } = await identity(env);
  const turn = conversation();
  await (await worker.fetch(request(turn, cookie), env)).text();
  const tampered = cookie + "broken";
  const response = await worker.fetch(request(turn, tampered, "/api/memory"), env);
  expect(response.status).toBe(403);
  expect(response.headers.get("Set-Cookie")).not.toBeNull();
  expect(run).toHaveBeenCalledTimes(1);
  access.now += 600000;
  expect((await worker.fetch(request(turn, cookie, "/api/memory"), env)).status).toBe(403);
  expect(run).toHaveBeenCalledTimes(1);
});

test("all ACCESS denial reasons map to correct statuses and never call providers", async () => {
  const upstream = spyOn(globalThis, "fetch");
  for (const [reason, status] of [
    ["weekly_limit", 429],
    ["rate_limit", 429],
    ["in_flight", 409],
    ["duplicate_turn", 409],
  ] as const) {
    const { env, access, run } = setup();
    access.reserveMo = async () => ({
      allowed: false,
      reason,
      remaining: 4,
      resetsAt: "2009-02-13T23:31:30.000Z",
    });
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(status);
    expect(response.headers.get("X-Agent-State")).not.toBeNull();
    expect(response.headers.get("Set-Cookie")).not.toBeNull();
    expect(response.headers.get("X-Mo-Remaining")).toBe("4");
    expect(response.headers.get("X-Mo-Resets-At")).toBe("2009-02-13T23:31:30.000Z");
    expect(((await response.json()) as { resetsAt: string }).resetsAt).toBe(
      "2009-02-13T23:31:30.000Z",
    );
    expect(run).not.toHaveBeenCalled();
  }
  expect(upstream).not.toHaveBeenCalled();
});

test("JEV failure preserves Mo fallback but refunds and does not issue memory grant", async () => {
  const { env, access, run } = setup();
  const { cookie, id } = await identity(env);
  const turn = conversation();
  run.mockRejectedValue(new Error("JEV unavailable"));
  spyOn(console, "warn").mockImplementation(() => {});
  const upstream = spyOn(globalThis, "fetch");
  const response = await worker.fetch(request(turn, cookie), env);
  expect(response.status).toBe(200);
  expect(access.calls.finish).toEqual([false]); // Refund before any response consumption.
  const record = JSON.parse(await response.text());
  expect(record.done).toBe(true);
  expect(SCOPE_REPLY_POOLS.unclear).toContain(record.message.content);
  expect(access.calls.finish).toEqual([false]); // EOF must not later mark the refunded turn successful.
  expect(await access.claimMoMemory(id, turn.turnId)).toBe(false);
  expect((await access.reserveMo(id, crypto.randomUUID())).remaining).toBe(19);
  expect(upstream).not.toHaveBeenCalled();
});

test("memory success and Ollama failure both consume grants without a weekly reservation", async () => {
  for (const fails of [false, true]) {
    const { env, access, run } = setup();
    const { cookie } = await identity(env);
    const turn = conversation();
    await (await worker.fetch(request(turn, cookie), env)).text(); // Completed scope redirect.
    run.mockResolvedValue({
      answers: {
        scope: { type: "choice", choice: "on_topic", confidence: 1 },
        update: { type: "noul", noul: 1 },
      },
    });
    const upstream = spyOn(globalThis, "fetch");
    if (fails) upstream.mockRejectedValue(new Error("Ollama unavailable"));
    else
      upstream.mockResolvedValue(
        Response.json({
          message: { content: '{"memories":[{"kind":"fact","content":"Prefers short replies"}]}' },
        }),
      );
    spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch(request(turn, cookie, "/api/memory"), env);
    expect(response.status).toBe(fails ? 502 : 200);
    expect(access.calls.reserve).toBe(1);
    expect(access.calls.finish).toEqual([true]);
    expect((await worker.fetch(request(turn, cookie, "/api/memory"), env)).status).toBe(403);
    expect(run).toHaveBeenCalledTimes(2);
  }
});

test("done before upstream error and cancellation during a pending read do not grant memory", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  for (const cancel of [false, true]) {
    const { env, access } = setup(true);
    const { cookie, id } = await identity(env);
    const turn = conversation();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    const response = await worker.fetch(request(turn, cookie), env);
    const reader = response.body!.getReader();
    if (cancel) {
      const pending = reader.read();
      await reader.cancel("gone");
      expect((await pending).done).toBe(true);
      expect(cancelled).toBe(true);
    } else {
      controller.enqueue(new TextEncoder().encode('{"done":true}\n'));
      await reader.read();
      expect(access.calls.finish).toEqual([]);
      controller.error(new Error("error after done"));
      await expect(reader.read()).rejects.toThrow();
    }
    expect(stream.locked).toBe(false);
    expect(access.calls.finish).toEqual([]);
    expect(await access.claimMoMemory(id, turn.turnId)).toBe(false);
  }
});

test("fixed cookie lifetime is signed, expires without sliding and rejects alternate cookie names", async () => {
  const { env } = setup();
  const now = Date.now();
  const minted = await visitorIdentity(request(), env, now);
  const cookie = minted.cookie!.split(";")[0];
  const read = await visitorIdentity(request(conversation(), cookie), env, now + 10000);
  expect(read.visitorId).toBe(minted.visitorId);
  expect(read.cookie).toBeUndefined();
  const expired = await visitorIdentity(
    request(conversation(), cookie),
    env,
    now + VISITOR_COOKIE_MAX_AGE_SECONDS * 1000,
  );
  expect(expired.visitorId).not.toBe(minted.visitorId);
  const wrongName = await visitorIdentity(
    request(conversation(), cookie.replace("__Host-mo-visitor", "mo-visitor")),
    env,
    now,
  );
  expect(wrongName.visitorId).not.toBe(minted.visitorId);
});

test("HTTP cookies require explicit local dev and ignore identity/IP headers", async () => {
  const { env } = setup();
  const local = new Request("http://localhost/api/chat", {
    headers: { "CF-Connecting-IP": "192.0.2.2" },
  });
  await expect(visitorIdentity(local, env)).rejects.toThrow();
  Object.assign(env, { ACCESS_LOCAL_DEV: "true" });
  const visitor = await visitorIdentity(local, env);
  expect(visitor.cookie).toStartWith("mo-visitor=v1.");
  expect(visitor.cookie).not.toContain("Secure");
  expect(burstKey(local)).toBe("anonymous");
  await expect(
    visitorIdentity(new Request("http://portfolio.example/api/chat"), env),
  ).rejects.toThrow();
});
