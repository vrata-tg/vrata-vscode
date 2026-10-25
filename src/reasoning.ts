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
    description: "выключить рассуждения",
  },
  { value: "low", label: "Low", description: "" },
  { value: "medium", label: "Medium", description: "" },
  { value: "high", label: "High", description: "" },
  { value: "xhigh", label: "Extra High", description: "" },
  { value: "max", label: "Max", description: "" },
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
  modelPreference?: unknown,
): ReasoningLevel | undefined {
  const override = options?.modelOptions
    ? (options.modelOptions as { reasoningEffort?: unknown }).reasoningEffort
    : undefined;
  return (
    normalizeReasoning(override) ??
    normalizeReasoning(modelPreference) ??
    normalizeReasoning(stored)
  );
}
