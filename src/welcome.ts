import * as vscode from "vscode";

export function modelPickerTabsEnabled(
  version: string,
  chat: Pick<vscode.WorkspaceConfiguration, "get">,
): boolean {
  const [major, minor] = version.split(".").map(Number);
  if (major > 1 || (major === 1 && minor >= 142)) return true;
  return chat.get<boolean>("experimentalModelPicker") === true;
}
