import * as vscode from "vscode";
import { Message, streamChat } from "./transport";
import {
  CredentialOperationCancelled,
  Credentials,
  SECRET_KEY,
} from "./credentials";
import { API_ORIGIN, BOT_URL, CredentialError, GatewayClient } from "./gateway";

function text(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) return part.value;
      throw new Error("Vrata supports text tool results only");
    })
    .join("\n");
}

export function toMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    const role =
      message.role === vscode.LanguageModelChatMessageRole.Assistant
        ? "assistant"
        : "user";
    let content = "";
    const calls: NonNullable<Message["tool_calls"]> = [];
    const flush = () => {
      if (content || calls.length)
        result.push({
          role,
          content: content || null,
          ...(calls.length ? { tool_calls: [...calls] } : {}),
        });
      content = "";
      calls.length = 0;
    };
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) content += part.value;
      else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push({
          id: part.callId,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        flush();
        result.push({
          role: "tool",
          tool_call_id: part.callId,
          content: text(part.content),
        });
      } else throw new Error("Vrata supports text and tool parts only");
    }
    flush();
  }
  return result;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const changes = new vscode.EventEmitter<void>();
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50,
  );
  status.command = "vrata.manage";
  const credentials = new Credentials(
    context.secrets,
    new GatewayClient(),
    () => {
      updateStatus();
      changes.fire();
    },
  );
  function updateStatus(): void {
    status.text = credentials.connected
      ? "$(key) Врата AI"
      : "$(plug) Врата AI: подключить";
    status.tooltip = credentials.connected
      ? "API-ключ сохранён. Управление подключением Врата AI"
      : "Врата AI не подключены. Вставьте API-ключ";
    void vscode.commands.executeCommand(
      "setContext",
      "vrata.connected",
      credentials.connected,
    );
  }
  function command(id: string, action: () => unknown): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          return await action();
        } catch (error) {
          if (error instanceof CredentialOperationCancelled) return;
          await vscode.window.showErrorMessage(
            error instanceof CredentialError
              ? error.message
              : "Не удалось изменить подключение Врата AI. Попробуйте ещё раз.",
          );
        }
      }),
    );
  }
  let editing = false;
  command("vrata.setApiKey", async () => {
    if (editing) return;
    editing = true;
    try {
      const value = await vscode.window.showInputBox({
        title: credentials.connected
          ? "Врата AI: заменить API-ключ"
          : "Врата AI: вставить API-ключ",
        prompt:
          "Ключ из бота Врата AI. Проверка не вызывает модель и не списывает средства.",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "Вставьте API-ключ",
        validateInput: (input) =>
          input.trim() ? undefined : "Вставьте API-ключ.",
      });
      if (value === undefined) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Врата AI: проверка ключа…",
        },
        () => credentials.replace(value),
      );
      await vscode.window.showInformationMessage(
        "API-ключ сохранён. Выбор моделей и баланс появятся в следующем этапе MVP.",
      );
    } finally {
      editing = false;
    }
  });
  command("vrata.removeApiKey", async () => {
    const answer = await vscode.window.showWarningMessage(
      "Удалить ключ из этого профиля VS Code? В других инструментах он продолжит работать.",
      { modal: true },
      "Удалить локальный ключ",
    );
    if (answer !== "Удалить локальный ключ") return;
    await credentials.remove();
    await vscode.window.showInformationMessage(
      "Локальный API-ключ удалён. Врата AI отключены.",
    );
  });
  command("vrata.getApiKey", () =>
    vscode.env.openExternal(vscode.Uri.parse(BOT_URL)),
  );
  command("vrata.openWalkthrough", () =>
    vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "vrata.vrata-ai#vrata.welcome",
      false,
    ),
  );
  command("vrata.utilitySettings", () =>
    vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "chat.byokUtilityModelDefault",
    ),
  );
  command("vrata.manage", async () => {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: credentials.connected
            ? "Заменить API-ключ"
            : "Вставить API-ключ",
          command: "vrata.setApiKey",
        },
        { label: "Получить ключ в боте", command: "vrata.getApiKey" },
        ...(credentials.connected
          ? [{ label: "Удалить локальный ключ", command: "vrata.removeApiKey" }]
          : []),
        { label: "Как начать работу", command: "vrata.openWalkthrough" },
      ],
      {
        title: credentials.connected
          ? "Врата AI — API-ключ сохранён"
          : "Врата AI — не подключены",
      },
    );
    if (choice) await vscode.commands.executeCommand(choice.command);
  });
  context.subscriptions.push(
    credentials,
    changes,
    status,
    context.secrets.onDidChange((event) => {
      if (event.key === SECRET_KEY) {
        void credentials.reload().catch(() => {
          void vscode.window.showErrorMessage(
            "Не удалось прочитать локальный ключ Врата AI.",
          );
        });
      }
    }),
  );
  try {
    await credentials.initialize();
  } catch {
    void vscode.window.showErrorMessage(
      "Не удалось прочитать локальный ключ Врата AI. Повторите подключение.",
    );
  }
  updateStatus();
  status.show();

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("vrata", {
      onDidChangeLanguageModelChatInformation: changes.event,
      async provideLanguageModelChatInformation(options, token) {
        if (token.isCancellationRequested) return [];
        // Add Models invokes non-silent discovery for providers with managementCommand.
        if (!options.silent)
          await vscode.commands.executeCommand("vrata.manage");
        // Background discovery never prompts, even if called repeatedly without credentials.
        if (!credentials.connected || token.isCancellationRequested) return [];
        try {
          await credentials.refresh();
        } catch {
          return [];
        }
        // #337/#338 supply verified limits/capabilities. Never advertise the spike's guesses.
        return [];
      },
      async provideTokenCount(_model, input) {
        // Approximate transport helper; replaced by catalog/token counting work in #338.
        return Math.ceil(
          Buffer.byteLength(
            typeof input === "string" ? input : JSON.stringify(input),
            "utf8",
          ) / 3,
        );
      },
      async provideLanguageModelChatResponse(
        model,
        messages,
        options,
        progress,
        token,
      ) {
        await credentials.run(async (session) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() =>
            controller.abort(),
          );
          if (token.isCancellationRequested) controller.abort();
          const signal = AbortSignal.any([controller.signal, session.signal]);
          try {
            await streamChat(
              `${API_ORIGIN}/v1/chat/completions`,
              session.key,
              {
                model: model.id,
                messages: toMessages(messages),
                max_tokens: model.maxOutputTokens,
                ...(options.tools?.length
                  ? {
                      tools: options.tools.map((tool) => ({
                        type: "function",
                        function: {
                          name: tool.name,
                          description: tool.description,
                          parameters: tool.inputSchema ?? {
                            type: "object",
                            properties: {},
                          },
                        },
                      })),
                      tool_choice:
                        options.toolMode ===
                        vscode.LanguageModelChatToolMode.Required
                          ? "required"
                          : "auto",
                    }
                  : {}),
              },
              signal,
              (part) => {
                if (!session.isCurrent() || signal.aborted) return;
                progress.report(
                  "text" in part
                    ? new vscode.LanguageModelTextPart(part.text)
                    : new vscode.LanguageModelToolCallPart(
                        part.id,
                        part.name,
                        part.input,
                      ),
                );
              },
            );
          } catch {
            if (signal.aborted) throw new vscode.CancellationError();
            throw new Error("Не удалось получить ответ Врата AI.");
          } finally {
            subscription.dispose();
          }
        });
      },
    }),
  );
  if (!context.globalState.get<boolean>("welcomeShown")) {
    await vscode.commands.executeCommand("vrata.openWalkthrough");
    await context.globalState.update("welcomeShown", true);
  }
}
