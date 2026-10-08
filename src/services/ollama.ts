import { compressionSchema } from "../schemas/conversation";

export async function ollama(
  env: Env,
  messages: { role: string; content: string }[],
  stream: boolean,
  memory = false,
  maxTokens = 300,
) {
  const base = new URL(env.OLLAMA_BASE_URL);
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("Invalid Ollama URL");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if ("OLLAMA_API_KEY" in env && typeof env.OLLAMA_API_KEY === "string" && env.OLLAMA_API_KEY)
    headers.Authorization = `Bearer ${env.OLLAMA_API_KEY}`;
  const response = await fetch(new URL("/api/chat", base), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: memory ? env.MEMORY_MODEL : env.OLLAMA_MODEL,
      messages,
      stream,
      ...(memory ? { format: compressionSchema.toJSONSchema() } : {}),
      options: { num_predict: memory ? 1600 : maxTokens },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Ollama returned ${response.status}`);
  }
  return response;
}
