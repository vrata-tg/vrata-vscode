export const REASONING_LEVELS = ["low", "medium", "high"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export function normalizeReasoning(value: unknown): ReasoningLevel | undefined {
  return typeof value === "string" &&
    (REASONING_LEVELS as readonly string[]).includes(value)
    ? (value as ReasoningLevel)
    : undefined;
}

export interface ReasoningRequestOptions {
  modelOptions?: object | undefined;
}

/**
 * The panel setting applies to every request; an explicit modelOptions
 * override from the caller wins. Unset means the server default.
 */
export function resolveReasoning(
  options: ReasoningRequestOptions | undefined,
  stored: unknown,
): ReasoningLevel | undefined {
  const override = options?.modelOptions
    ? (options.modelOptions as { reasoningEffort?: unknown }).reasoningEffort
    : undefined;
  return normalizeReasoning(override) ?? normalizeReasoning(stored);
}

/** Only the verified chat_completions contract carries reasoning_effort. */
export function chatCompletionsReasoning(effort: ReasoningLevel | undefined): {
  reasoning_effort?: ReasoningLevel;
} {
  return effort ? { reasoning_effort: effort } : {};
}
