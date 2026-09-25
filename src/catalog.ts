import * as vscode from "vscode";

export interface CatalogProjection {
  models: vscode.LanguageModelChatInformation[];
  unavailable: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function limit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The server's max_input_tokens is an input cap, not a total context window. */
export function projectCatalog(entries: readonly unknown[]): CatalogProjection {
  const models: vscode.LanguageModelChatInformation[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const item = record(entry);
    if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
    const id = item.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const metadata = record(item.gateway_metadata);
    if (!metadata) {
      unavailable.push(`${id}: нет подтверждённых metadata`);
      continue;
    }
    let reason: string | undefined;
    if (metadata.protocol !== "openai")
      reason = "нет доступа через Chat Completions";
    else if (metadata.verified_transport !== "chat_completions")
      reason = "транспорт для агента не подтверждён";
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
      unavailable.push(`${id}: ${reason}`);
      continue;
    }
    models.push({
      id,
      name: metadata.name as string,
      family: metadata.family as string,
      version: id,
      maxInputTokens: metadata.max_input_tokens as number,
      maxOutputTokens: metadata.max_output_tokens as number,
      capabilities: { toolCalling: true, imageInput: false },
    });
  }
  return { models, unavailable };
}
