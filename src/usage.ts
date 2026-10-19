export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Counts cross the server boundary and may be absent even on a valid response.
export function tokenUsage(
  input: unknown,
  output: unknown,
  cached: unknown = 0,
): Usage | undefined {
  if (!tokenCount(input) || !tokenCount(output) || !tokenCount(cached))
    return undefined;
  const total = input + output;
  if (!tokenCount(total) || cached > input) return undefined;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    prompt_tokens_details: { cached_tokens: cached },
  };
}

export function messagesUsage(
  usage: Record<string, unknown>,
  output: unknown,
): Usage | undefined {
  const input = usage.input_tokens;
  const cached = usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  if (!tokenCount(input) || !tokenCount(cached) || !tokenCount(created))
    return undefined;
  return tokenUsage(input + cached + created, output, cached);
}
