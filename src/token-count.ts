import { Message } from "./transport";

export function estimateTokens(input: string | readonly Message[]): number {
  // Local approximation: UTF-8 bytes are not tokens. Tokenizers vary by model.
  if (typeof input === "string")
    return Math.max(1, Math.ceil(Buffer.byteLength(input, "utf8") / 4));
  const serialized = JSON.stringify(input);
  const parts = input.reduce(
    (count, message) => count + (message.tool_calls?.length ?? 0),
    0,
  );
  return Math.max(
    16,
    estimateTokens(serialized) + Math.max(1, input.length) * 16 + parts * 16,
  );
}
