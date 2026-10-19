import * as vscode from "vscode";

export interface CatalogProjection {
  models: vscode.LanguageModelChatInformation[];
  unavailable: string[];
  transports: Record<string, "chat_completions" | "messages" | "responses">;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function limit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// The production catalog currently omits this flag for gpt-6.1-sol even though
// the model accepts the image payload used by this provider. Keep the exception
// explicit instead of inferring vision support from a model family.
const KNOWN_VISION_MODELS = new Set(["gpt-6.1-sol"]);

/** The server's max_input_tokens is an input cap, not a total context window. */
export function projectCatalog(entries: readonly unknown[]): CatalogProjection {
  const models: vscode.LanguageModelChatInformation[] = [];
  const unavailable: string[] = [];
  const transports: CatalogProjection["transports"] = Object.create(null);
  const rejected = new Map<string, string>();
  for (const entry of entries) {
    const item = record(entry);
    if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
    const id = item.id;
    const metadata = record(item.gateway_metadata);
    if (!metadata) {
      rejected.set(id, `${id}: нет подтверждённых metadata`);
      continue;
    }
    let reason: string | undefined;
    const transport =
      metadata.protocol === "openai" &&
      (metadata.verified_transport === "chat_completions" ||
        metadata.verified_transport === "responses")
        ? metadata.verified_transport
        : metadata.protocol === "anthropic" &&
            metadata.verified_transport === "messages"
          ? "messages"
          : undefined;
    if (!transport) reason = "транспорт для агента не подтверждён";
    else if (metadata.supports_tools !== true)
      reason = "вызов инструментов не подтверждён";
    else if (
      typeof metadata.name !== "string" ||
      !metadata.name.trim() ||
      typeof metadata.family !== "string" ||
      !metadata.family.trim()
    )
      reason = "имя или семейство не подтверждены";
    else if (
      !limit(metadata.max_input_tokens) ||
      !limit(metadata.max_output_tokens)
    )
      reason = "пределы входа или ответа не подтверждены";
    if (reason) {
      rejected.set(id, `${id}: ${reason}`);
      continue;
    }
    if (
      transports[id] === "messages" ||
      (transports[id] === "responses" && transport !== "messages") ||
      (transports[id] === "chat_completions" &&
        transport === "chat_completions")
    )
      continue;
    const model = {
      id,
      name: metadata.name as string,
      family: metadata.family as string,
      version: id,
      maxInputTokens: metadata.max_input_tokens as number,
      maxOutputTokens: metadata.max_output_tokens as number,
      capabilities: {
        toolCalling: true,
        imageInput:
          metadata.supports_images === true ||
          (metadata.supports_images == null && KNOWN_VISION_MODELS.has(id)),
      },
    };
    if (transports[id])
      models[models.findIndex((existing) => existing.id === id)] = model;
    else models.push(model);
    transports[id] = transport!;
  }
  for (const [id, reason] of rejected)
    if (!transports[id]) unavailable.push(reason);
  return { models, unavailable, transports };
}
