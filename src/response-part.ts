import * as vscode from "vscode";
import { Part } from "./transport";

export function toResponsePart(
  part: Part,
): vscode.LanguageModelResponsePart | undefined {
  if ("text" in part) return new vscode.LanguageModelTextPart(part.text);
  if ("usage" in part) {
    // Stable since 1.106; keep the extension usable with the pinned 1.104 API.
    const [major, minor] = vscode.version.split(".").map(Number);
    if (major < 1 || (major === 1 && minor < 106)) return undefined;
    const DataPart = (
      vscode as typeof vscode & {
        LanguageModelDataPart?: new (
          data: Uint8Array,
          mimeType: string,
        ) => unknown;
      }
    ).LanguageModelDataPart;
    if (!DataPart) return undefined;
    return new DataPart(
      new TextEncoder().encode(JSON.stringify(part.usage)),
      "usage",
    ) as vscode.LanguageModelResponsePart;
  }
  return new vscode.LanguageModelToolCallPart(part.id, part.name, part.input);
}
