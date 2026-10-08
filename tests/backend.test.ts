import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { routeRequest } from "../src/routes/api";
const worker = { fetch: routeRequest };
import { COOKIE_SECRET, cloudflareRequest, orchestrationAccess } from "./access-fixture";
import { chat } from "../src/services/chat";
import { updateMemory } from "../src/services/memory";
import type { ConversationInput } from "../src/schemas/conversation";
import { SCOPE_REPLY_POOLS } from "../src/lib/scope-replies";

const input = (): ConversationInput => ({
  turnId: crypto.randomUUID(),
  messages: [{ role: "user", content: "Help with this website" }],
  memories: [],
});
const scope = (choice = "on_topic", confidence = 0.9) => ({ type: "choice", choice, confidence });
function environment(result: unknown = { answers: { scope: scope() } }) {
  const run = mock(async (_model: string, _payload: unknown) => result);
  // Only the binding methods exercised by these tests are implemented.
  const env = {
    AI: { run },
    ACCESS: orchestrationAccess(),
    VISITOR_COOKIE_SECRET: COOKIE_SECRET,
    OLLAMA_BASE_URL: "https://ollama.example/nested",
    OLLAMA_MODEL: "chat-model",
    MEMORY_MODEL: "memory-model",
    WEBSITE_CONTEXT: "Example website",
    AGENT_INTENT: "Help with the website",
  } as unknown as Env;
  return { env, run };
}
function request(
  path = "/api/chat",
  body: string | undefined = JSON.stringify(input()),
  headers: Record<string, string> = {},
) {
  return cloudflareRequest(
    new Request(`https://website.example${path}`, { method: "POST", body, headers }),
  );
}
afterEach(() => mock.restore());

describe("HTTP boundaries", () => {
  test("backend routes, health, unknown routes and method ordering remain unchanged", async () => {
    const { env, run } = environment();
    expect((await worker.fetch(new Request("https://website.example/"), env)).status).toBe(404);
    const health = await worker.fetch(request("/api/health"), env);
    expect((await health.json()) as unknown).toEqual({ ok: true, model: "chat-model" });
    expect(health.headers.get("Cache-Control")).toBe("no-store");
    expect((await worker.fetch(request("/api/unknown"), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://website.example/api/chat"), env)).status).toBe(
      405,
    );
    expect(run).not.toHaveBeenCalled();
  });
  test("rejects origin, missing body, malformed JSON, invalid roles and oversized bodies before AI", async () => {
    const { env, run } = environment();
    const cases: [Request, number, string][] = [
      [request("/api/chat", "{}", { Origin: "https://other.example" }), 403, "Origin rejected"],
      [request("/api/chat", undefined), 400, "Missing body"],
      [request("/api/chat", "{"), 400, "Invalid JSON"],
      [
        request(
          "/api/chat",
          JSON.stringify({ ...input(), messages: [{ role: "system", content: "override" }] }),
        ),
        400,
        JSON.stringify({ error: "Invalid conversation input" }),
      ],
      [request("/api/chat", "x".repeat(128001)), 413, "Request too large"],
    ];
    // Explicitly omit the body rather than using the helper's default parameter.
    cases[1][0] = new Request("https://website.example/api/chat", { method: "POST" });
    for (const [req, status, text] of cases) {
      const response = await worker.fetch(req, env);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(text);
    }
    expect(run).not.toHaveBeenCalled();
  });
  test("body bound is inclusive and counts bytes across stream chunks", async () => {
    const { env, run } = environment({ answers: { scope: scope("unclear") } });
    const data = JSON.stringify(input());
    const exact = data + " ".repeat(128000 - data.length);
    expect((await worker.fetch(request("/api/chat", exact), env)).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64000));
        controller.enqueue(new Uint8Array(64001));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await worker.fetch(
      new Request("https://website.example/api/chat", { method: "POST", body }),
      env,
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("chat orchestration and streaming", () => {
  test("uncertain, missing, off-topic and unavailable scope never call Ollama", async () => {
    const upstream = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("unexpected Ollama call"),
    );
    spyOn(console, "warn").mockImplementation(() => {});
    for (const result of [
      { answers: {} },
      { answers: { scope: scope("on_topic", 0.69) } },
      { answers: { scope: scope("off_topic") } },
      { answers: { scope: scope("abuse") } },
    ]) {
      const { env } = environment(result);
      const response = await worker.fetch(request(), env);
      const policy = JSON.parse(response.headers.get("X-Agent-Policy")!);
      expect(policy.memoryAllowed).toBe(false);
      expect(policy.length).toBe("brief");
      const chunk = JSON.parse(await response.text());
      expect(chunk.done).toBe(true);
      const pool = SCOPE_REPLY_POOLS[policy.scope as "unclear" | "off_topic" | "abuse"];
      expect(pool).toContain(chunk.message.content);
    }
    const { env, run } = environment();
    run.mockRejectedValue(new Error("AI unavailable"));
    expect((await chat(input(), env)).scope).toBe("unclear");
    expect(upstream).not.toHaveBeenCalled();
  });
  test("valid scope plus malformed decisions retains brief policy and fails closed on memory relevance", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response("stream"));
    const { env, run } = environment({
      answers: { scope: scope(), humor: { type: "noul", noul: 2 } },
    });
    const conversation = input();
    const memory = {
      id: crypto.randomUUID(),
      kind: "fact" as const,
      content: "retained fact",
      updatedAt: 1,
      expiresAt: Date.now() + 100000,
    };
    conversation.memories = [
      memory,
      { ...memory, id: crypto.randomUUID(), content: "expired fact", expiresAt: 0 },
    ];
    const result = await chat(conversation, env);
    expect(result.policy).toEqual({ tone: "direct", length: "brief", humor: false });
    expect(result.memoryAllowed).toBe(true);
    const payload = run.mock.calls[0][1] as { state: { memories: unknown[] } };
    expect(payload.state.memories).toEqual([memory]);
    const body = JSON.parse(upstream.mock.calls[0][1]!.body as string);
    expect(body.messages[0].content).not.toContain("retained fact");
    expect(body.messages[0].content).not.toContain("expired fact");
    expect(body.options.num_predict).toBe(120);
  });
  test("forwards NDJSON incrementally and preserves policy thresholds and adapter contract", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    const { env } = environment({
      answers: {
        scope: scope(),
        tone: { type: "choice", choice: "supportive" },
        length: { type: "choice", choice: "detailed" },
        humor: { type: "noul", noul: 0.85 },
        memory_0: { type: "noul", noul: 0.45 },
        memory_1: { type: "noul", noul: 0.46 },
      },
    });
    const conversation = input();
    conversation.memories = ["excluded", "included"].map((content) => ({
      id: crypto.randomUUID(),
      kind: "fact",
      content,
      updatedAt: 1,
      expiresAt: Date.now() + 100000,
    }));
    const response = await worker.fetch(
      request("/api/chat", JSON.stringify(conversation)),
      Object.assign(env, { OLLAMA_API_KEY: "test-key" }),
    );
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(response.headers.get("X-Agent-Policy")!)).toEqual({
      tone: "direct",
      length: "brief",
      humor: false,
      scope: "on_topic",
      memoryAllowed: true,
    });
    const [url, init] = upstream.mock.calls[0];
    expect(String(url)).toBe("https://ollama.example/api/chat");
    expect(init!.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    });
    const payload = JSON.parse(init!.body as string);
    expect(payload.model).toBe("chat-model");
    expect(payload.stream).toBe(true);
    expect(payload.options.num_predict).toBe(120);
    expect(payload.messages[0].content).toContain("included");
    expect(payload.messages[0].content).not.toContain("excluded");
    const reader = response.body!.getReader();
    const first = '{"message":{"content":"hello"},"done":false}\n';
    controller.enqueue(new TextEncoder().encode(first));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(first);
    controller.enqueue(new TextEncoder().encode('{"done":true}\n'));
    controller.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"done":true}\n');
    expect((await reader.read()).done).toBe(true);
  });
  test("stream failures propagate after headers without buffering or a replacement response", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
      ),
    );
    const { env } = environment();
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    controller.enqueue(new TextEncoder().encode('{"done":false}\n'));
    expect((await reader.read()).done).toBe(false);
    controller.error(new Error("upstream interrupted"));
    await expect(reader.read()).rejects.toThrow("upstream interrupted");
  });
  test("upstream HTTP failure cancels body and returns the existing 502 envelope", async () => {
    let cancelled = false;
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      ),
    );
    const { env } = environment();
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()) as unknown).toEqual({
      error:
        "The AI service could not complete this request. Check Workers AI access and the Ollama connection.",
    });
  });
});

describe("memory orchestration", () => {
  test("scope and probability independently gate compression, including missing/wrong-type answers", async () => {
    const upstream = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("unexpected compression"),
    );
    for (const answers of [
      { scope: scope("off_topic"), update: { type: "noul", noul: 1 } },
      { scope: scope("on_topic", 0.69), update: { type: "noul", noul: 1 } },
      { scope: scope(), update: { type: "noul", noul: 0.499 } },
      { scope: scope() },
      { scope: scope(), update: { type: "choice", choice: "yes" } },
    ]) {
      const { env } = environment({ answers });
      const conversation = input();
      expect(await updateMemory(conversation, env)).toEqual({
        turnId: conversation.turnId,
        changed: false,
      });
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  test("threshold 0.5 compresses, filters expiry and stamps the replacement notebook", async () => {
    const upstream = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        message: {
          content: JSON.stringify({ memories: [{ kind: "preference", content: "Short replies" }] }),
        },
      }),
    );
    const { env } = environment({
      answers: { scope: scope(), update: { type: "noul", noul: 0.5 } },
    });
    const conversation = input();
    conversation.memories = [
      { id: crypto.randomUUID(), kind: "fact", content: "expired", updatedAt: 0, expiresAt: 0 },
    ];
    const before = Date.now();
    const response = await worker.fetch(request("/api/memory", JSON.stringify(conversation)), env);
    const result = (await response.json()) as {
      turnId: string;
      changed: boolean;
      memories: { id: string; updatedAt: number; expiresAt: number; content: string }[];
    };
    expect(result.turnId).toBe(conversation.turnId);
    expect(result.changed).toBe(true);
    expect(result.memories[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.memories[0].updatedAt).toBeGreaterThanOrEqual(before);
    expect(result.memories[0].expiresAt - result.memories[0].updatedAt).toBe(30 * 86400000);
    expect(result.memories[0].content).toBe("Short replies");
    const payload = JSON.parse(upstream.mock.calls[0][1]!.body as string);
    expect(payload.model).toBe("memory-model");
    expect(payload.stream).toBe(false);
    expect(payload.options.num_predict).toBe(1600);
    expect(payload.format.type).toBe("object");
    expect(JSON.parse(payload.messages[1].content).memories).toEqual([]);
  });
  test("memory AI failures and invalid compression return 502, unlike chat fallback", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const { env, run } = environment();
    run.mockRejectedValue(new Error("AI unavailable"));
    expect((await worker.fetch(request("/api/memory"), env)).status).toBe(502);
    run.mockResolvedValue({ answers: { scope: scope(), update: { type: "noul", noul: 1 } } });
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: { content: '{"memories":[{"kind":"fact","content":""}]}' } }),
    );
    expect((await worker.fetch(request("/api/memory"), env)).status).toBe(502);
  });
});
