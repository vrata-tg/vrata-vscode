import * as vscode from "vscode";

export function modelPickerTabsEnabled(
  version: string,
  chat: Pick<vscode.WorkspaceConfiguration, "get" | "inspect">,
): boolean {
  if (chat.inspect<boolean>("experimentalModelPicker") !== undefined) {
    return chat.get<boolean>("experimentalModelPicker") === true;
  }

  const [major, minor] = version.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 142);
}
