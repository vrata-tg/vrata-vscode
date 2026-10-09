export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface ReasoningChoice {
  value: ReasoningLevel;
  label: string;
  description: string;
}

/**
 * The full picker set. none disables reasoning; xhigh and max are the
 * gateway's extra levels above high. Every value is accepted by the
 * chat_completions reasoning_effort field.
 */
export const REASONING_CHOICES: readonly ReasoningChoice[] = [
  {
    value: "none",
    label: "None",
    description: "reasoning_effort: none — выключить рассуждения",
  },
  { value: "low", label: "Low", description: "reasoning_effort: low" },
  { value: "medium", label: "Medium", description: "reasoning_effort: medium" },
  { value: "high", label: "High", description: "reasoning_effort: high" },
  {
    value: "xhigh",
    label: "Extra High",
    description: "reasoning_effort: xhigh",
  },
  { value: "max", label: "Max", description: "reasoning_effort: max" },
];

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
