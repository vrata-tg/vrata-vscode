const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
interface ReasoningChoice {
  value: ReasoningLevel;
  label: string;
  description: string;
}

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

export function resolveReasoning(
  options: { modelOptions?: object } | undefined,
  stored: unknown,
): ReasoningLevel | undefined {
  const override = options?.modelOptions
    ? (options.modelOptions as { reasoningEffort?: unknown }).reasoningEffort
    : undefined;
  return normalizeReasoning(override) ?? normalizeReasoning(stored);
}
