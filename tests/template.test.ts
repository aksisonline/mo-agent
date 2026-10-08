import { expect, mock, spyOn, test } from "bun:test";
import { chat } from "../src/services/chat";
import { accessService } from "../src/services/access";
import { BASE_KNOWLEDGE, KNOWLEDGE_DETAILS } from "../src/lib/knowledge";

test("unconfigured template gives no fictional biography and honors configured scope", async () => {
  const upstream = spyOn(globalThis, "fetch").mockResolvedValue(new Response("stream"));
  try {
    const env = {
      AI: {
        run: async () => ({
          answers: { scope: { type: "choice", choice: "on_topic", confidence: 1 } },
        }),
      },
      WEBSITE_CONTEXT: "Example portfolio",
      AGENT_INTENT: "Represent the configured owner",
      OLLAMA_BASE_URL: "https://ollama.example",
      OLLAMA_MODEL: "test",
    } as unknown as Env;
    await chat(
      {
        turnId: crypto.randomUUID(),
        messages: [{ role: "user", content: "Who is the owner?" }],
        memories: [],
      },
      env,
    );
    const prompt = JSON.parse(upstream.mock.calls[0][1]!.body as string).messages[0].content;
    expect(prompt).toContain(BASE_KNOWLEDGE);
    expect(prompt).toContain(env.WEBSITE_CONTEXT);
    expect(prompt).toContain(env.AGENT_INTENT);
    expect(Object.values(KNOWLEDGE_DETAILS).every((value) => value === "")).toBe(true);
  } finally {
    upstream.mockRestore();
  }
});

test("included quota namespace handles reservation, completion and memory without an external service", async () => {
  const reservationId = crypto.randomUUID();
  const stub = {
    reserve: mock(async () => ({
      allowed: true,
      remaining: 19,
      resetsAt: "2026-10-12T00:00:00.000Z",
      reservationId,
    })),
    finish: mock(async () => {}),
    claimMemory: mock(async () => true),
  };
  const getByName = mock(() => stub);
  const access = accessService({ MO_QUOTAS: { getByName } } as unknown as Env);
  const visitor = crypto.randomUUID();
  const turn = crypto.randomUUID();
  expect((await access.reserveMo(visitor, turn)).allowed).toBe(true);
  await access.finishMo(visitor, turn, reservationId, true);
  expect(await access.claimMoMemory(visitor, turn)).toBe(true);
  expect(getByName).toHaveBeenCalledWith(visitor);
  expect(stub.finish).toHaveBeenCalledWith(turn, reservationId, true);
  stub.reserve.mockResolvedValue({
    allowed: true,
    remaining: 99,
    resetsAt: "2026-10-12T00:00:00.000Z",
    reservationId,
  });
  await expect(access.reserveMo(visitor, turn)).rejects.toThrow();
});
