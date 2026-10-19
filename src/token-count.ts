import { Message } from "./transport";

/** Local upper estimate for byte-oriented tokenizers; includes JSON framing. */
export function estimateTokens(input: string | readonly Message[]): number {
  if (typeof input === "string")
    return Math.max(1, Buffer.byteLength(input, "utf8"));
  const serialized = JSON.stringify(input);
  const parts = input.reduce(
    (count, message) => count + (message.tool_calls?.length ?? 0),
    0,
  );
  return Math.max(
    16,
    Buffer.byteLength(serialized, "utf8") +
      Math.max(1, input.length) * 16 +
      parts * 16,
  );
}
