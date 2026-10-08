export const MAX_NDJSON_LINE_BYTES = 65536;

// Pull one upstream chunk at a time; never buffer the response or infer success from EOF alone.
export function completedMoStream(
  upstream: ReadableStream<Uint8Array>,
  onComplete: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let line = "";
  let lineBytes = 0;
  let doneRecord = false;
  let stopped = false;
  let released = false;
  const release = () => {
    if (!released) {
      reader.releaseLock();
      released = true;
    }
  };
  const record = (text: string) => {
    if (!text.trim()) return;
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      !("done" in value) ||
      typeof value.done !== "boolean" ||
      "error" in value ||
      doneRecord
    )
      throw new Error("Invalid provider stream");
    doneRecord = value.done;
  };
  const inspect = (chunk: Uint8Array) => {
    // Slice before decoding so a single oversized provider chunk cannot grow the line buffer.
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      const text = decoder.decode(chunk.subarray(offset, offset + 4096), { stream: true });
      for (const character of text) {
        if (character === "\n") {
          record(line);
          line = "";
          lineBytes = 0;
        } else {
          const codePoint = character.codePointAt(0)!;
          lineBytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
          if (lineBytes > MAX_NDJSON_LINE_BYTES) throw new Error("Provider line too large");
          line += character;
        }
      }
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (stopped) return;
          if (chunk.done) {
            line += decoder.decode();
            record(line);
            stopped = true;
            release();
            if (doneRecord) await onComplete();
            else console.warn(JSON.stringify({ event: "mo_stream_incomplete" }));
            controller.close();
          } else {
            inspect(chunk.value);
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          if (stopped) return;
          stopped = true;
          console.warn(JSON.stringify({ event: "mo_stream_failed" }));
          try {
            await reader.cancel();
          } catch {
            /* Upstream may already be errored. */
          } finally {
            release();
          }
          controller.error(error);
        }
      },
      async cancel(reason) {
        stopped = true;
        console.warn(JSON.stringify({ event: "mo_stream_cancelled" }));
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 0 },
  );
}
