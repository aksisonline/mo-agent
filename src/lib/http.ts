export const jsonHeaders = { "Cache-Control": "no-store" };

export async function readJsonBody(
  request: Request,
): Promise<{ raw: unknown; error?: never } | { error: Response; raw?: never }> {
  const reader = request.body?.getReader();
  if (!reader) return { error: new Response("Missing body", { status: 400 }) };
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 128000) {
      await reader.cancel();
      return { error: new Response("Request too large", { status: 413 }) };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { error: new Response("Invalid JSON", { status: 400 }) };
  }
  return { raw };
}
