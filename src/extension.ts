import * as vscode from "vscode";
import { formatError } from "./diagnostics";
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
  const output = vscode.window.createOutputChannel("Врата AI", { log: true });
  context.subscriptions.push(output);
  try {
    await activateWithOutput(context, output);
  } catch (error) {
    output.error(formatError(error));
    throw error;
  }
}

async function activateWithOutput(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const changes = new vscode.EventEmitter<void>();
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50,
  );
  status.command = "vrata.manage";
  const credentials = new Credentials(
    context.secrets,
    new GatewayClient(fetch, (message) => output.info(message)),
    () => {
      updateStatus();
      changes.fire();
    },
  );
  function logError(error: unknown, ...keys: (string | undefined)[]): void {
    output.error(formatError(error, credentials.key, ...keys));
  }
  async function showError(message: string): Promise<void> {
    try {
      if (
        (await vscode.window.showErrorMessage(message, "Открыть журнал")) ===
        "Открыть журнал"
      ) {
        output.show(true);
      }
    } catch (error) {
      logError(error);
    }
  }
  function updateStatus(): void {
    status.text = credentials.connected
      ? "$(key) Врата AI"
      : "$(plug) Врата AI: подключить";
    status.tooltip = credentials.connected
      ? "API-ключ сохранён. Управление подключением Врата AI"
      : "Врата AI не подключены. Вставьте API-ключ";
    void vscode.commands
      .executeCommand("setContext", "vrata.connected", credentials.connected)
      .then(undefined, (error) => logError(error));
  }
  function command(id: string, action: (keys: string[]) => unknown): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        const keys = credentials.key ? [credentials.key] : [];
        try {
          return await action(keys);
        } catch (error) {
          logError(error, ...keys);
          if (error instanceof CredentialOperationCancelled) return;
          const message =
            error instanceof CredentialError
              ? error.message
              : "Не удалось выполнить команду Врат AI.";
          await showError(message);
        }
      }),
    );
  }
  command("vrata.showLogs", () => output.show(true));
  let editing = false;
  command("vrata.setApiKey", async (keys) => {
    if (editing) return;
    editing = true;
    try {
      const value = await vscode.window.showInputBox({
        title: credentials.connected
          ? "Врата AI: заменить API-ключ"
          : "Врата AI: вставить API-ключ",
        prompt: "Ключ из бота Врата AI в формате sk-***",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "Вставьте API-ключ",
        validateInput: (input) =>
          input.trim() ? undefined : "Вставьте API-ключ.",
      });
      if (value === undefined) return;
      keys.push(value.trim());
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Врата AI: проверка ключа…",
        },
        () => credentials.replace(value),
      );
      void vscode.window
        .showInformationMessage("API-ключ сохранён.")
        .then(undefined, (error) => logError(error, ...keys));
    } finally {
      editing = false;
    }
  });
  command("vrata.removeApiKey", async () => {
    const answer = await vscode.window.showWarningMessage(
      "Удалить ключ из этого профиля VS Code?",
      { modal: true },
      "Удалить ключ",
    );
    if (answer !== "Удалить ключ") return;
    await credentials.remove();
    await vscode.window.showInformationMessage("Врата AI отключены.");
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
  command("vrata.utilitySettings", () => {
    const setting = vscode.workspace
      .getConfiguration("chat")
      .inspect<string>("byokUtilityModelDefault");
    if (setting?.defaultValue === undefined) {
      return vscode.window.showInformationMessage(
        "Настройка служебной модели недоступна в этой версии VS Code. Для неё обновите редактор. Подключением Врат AI можно управлять через строку состояния.",
      );
    }
    return vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "chat.byokUtilityModelDefault",
    );
  });
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
          ? [{ label: "Удалить ключ", command: "vrata.removeApiKey" }]
          : []),
        { label: "Открыть журнал", command: "vrata.showLogs" },
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
        const key = credentials.key;
        void credentials.reload().catch((error) => {
          logError(error, key);
          return showError("Не удалось прочитать ключ Врат AI.");
        });
      }
    }),
  );
  try {
    await credentials.initialize();
  } catch (error) {
    logError(error);
    await showError(
      "Не удалось прочитать ключ Врат AI. Повторите подключение.",
    );
  }
  updateStatus();
  status.show();

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("vrata", {
      onDidChangeLanguageModelChatInformation: changes.event,
      async provideLanguageModelChatInformation(options, token) {
        let key = credentials.key;
        try {
          if (token.isCancellationRequested) return [];
          // Add Models invokes non-silent discovery for providers with managementCommand.
          if (!options.silent)
            await vscode.commands.executeCommand("vrata.manage");
          // Background discovery never prompts, even if called repeatedly without credentials.
          if (!credentials.connected || token.isCancellationRequested)
            return [];
          key = credentials.key;
          await credentials.loadCatalog();
          // #337/#338 supply verified limits/capabilities. Never advertise the spike's guesses.
          return [];
        } catch (error) {
          logError(error, key);
          return [];
        }
      },
      async provideTokenCount(_model, input) {
        try {
          // Approximate transport helper; replaced by catalog/token counting work in #338.
          return Math.ceil(
            Buffer.byteLength(
              typeof input === "string" ? input : JSON.stringify(input),
              "utf8",
            ) / 3,
          );
        } catch (error) {
          logError(error);
          throw error;
        }
      },
      async provideLanguageModelChatResponse(
        model,
        messages,
        options,
        progress,
        token,
      ) {
        let key: string | undefined;
        let signal: AbortSignal | undefined;
        try {
          await credentials.run(async (session) => {
            key = session.key;
            const controller = new AbortController();
            const subscription = token.onCancellationRequested(() =>
              controller.abort(),
            );
            if (token.isCancellationRequested) controller.abort();
            signal = AbortSignal.any([controller.signal, session.signal]);
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
                  if (!session.isCurrent() || signal?.aborted) return;
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
            } finally {
              subscription.dispose();
            }
          });
        } catch (error) {
          logError(error, key);
          if (signal?.aborted) throw new vscode.CancellationError();
          // eslint-disable-next-line preserve-caught-error -- The original is logged above; its cause may expose a key to the editor.
          throw new Error("Не удалось получить ответ Врат AI.");
        }
      },
    }),
  );
  if (!context.globalState.get<boolean>("welcomeShown")) {
    await vscode.commands.executeCommand("vrata.openWalkthrough");
    await context.globalState.update("welcomeShown", true);
  }
}
