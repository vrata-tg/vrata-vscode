import * as vscode from "vscode";
import { diagnosticReport, formatError } from "./diagnostics";
import { Message, streamChat } from "./transport";
import { streamMessages, toAnthropicMessages } from "./messages-transport";
import { projectCatalog } from "./catalog";
import { estimateTokens } from "./token-count";
import { accountTooltip, rubles } from "./account";
import { requestError } from "./request-errors";
import {
  CredentialOperationCancelled,
  Credentials,
  SECRET_KEY,
} from "./credentials";
import {
  AccountError,
  API_ORIGIN,
  STAGING_API_ORIGIN,
  BOT_URL,
  CredentialError,
  GatewayClient,
} from "./gateway";
import { VrataPanel, registerPanelCommands } from "./panel";
import { chatCompletionsReasoning, resolveReasoning } from "./reasoning";

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
  let accountKey: string | undefined;
  let lastDiagnostic: { modelId?: string; code?: string; requestId?: string } =
    {};
  let lastNoticeCode: string | undefined;
  let lastNoticeAt = 0;
  let catalogKey: string | undefined;
  let lastCatalog: readonly unknown[] | undefined;
  const credentials = new Credentials(
    context.secrets,
    new GatewayClient(fetch, (message) => output.info(message)),
    () => {
      updateStatus();
      if (
        catalogKey !== credentials.key ||
        lastCatalog !== credentials.catalog
      ) {
        catalogKey = credentials.key;
        lastCatalog = credentials.catalog;
        changes.fire();
      }
      if (accountKey !== credentials.key) {
        accountKey = credentials.key;
        lastDiagnostic = {};
        lastNoticeCode = undefined;
        if (accountKey) {
          const key = accountKey;
          void credentials.loadAccount().catch((error) => logError(error, key));
        }
      }
      panel.refresh();
      panel.maybeAutoRefresh();
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
  function notifyRequestFailure(detail: ReturnType<typeof requestError>): void {
    const now = Date.now();
    if (lastNoticeCode === detail.code && now - lastNoticeAt < 60_000) return;
    lastNoticeCode = detail.code;
    lastNoticeAt = now;
    const action = detail.action;
    void Promise.resolve(
      vscode.window.showErrorMessage(
        detail.message,
        ...(action ? [action.label] : []),
      ),
    )
      .then((choice) => {
        if (action && choice === action.label)
          return vscode.commands.executeCommand(action.command);
      })
      .catch((error) => logError(error));
  }
  function updateStatus(): void {
    const { unavailable } = projectCatalog(credentials.catalog);
    const account = credentials.account;
    status.text = !credentials.connected
      ? "$(plug) Врата AI: подключить"
      : credentials.accountInvalid
        ? "$(warning) Врата AI: неверный ключ"
        : account
          ? `$(key) Врата AI: ${rubles(account.balance.spendable)}${credentials.accountStale ? " (устарело)" : ""}`
          : credentials.accountUnavailable
            ? "$(warning) Врата AI: нет связи"
            : "$(sync~spin) Врата AI: баланс…";
    const tooltip = [
      account && !credentials.accountInvalid
        ? accountTooltip(account)
        : undefined,
      credentials.accountStale
        ? "Данные баланса устарели: обновление не удалось."
        : undefined,
      credentials.accountInvalid
        ? "Ключ недействителен. Замените его."
        : undefined,
      credentials.accountUnavailable && !credentials.accountInvalid
        ? "Не удалось получить баланс. Обновите его вручную."
        : undefined,
      credentials.catalogUnavailable
        ? "Каталог Врат AI недоступен. Обновите список моделей."
        : undefined,
      credentials.catalogStale ? "Каталог моделей устарел." : undefined,
      credentials.catalogLoaded && !credentials.catalog.length
        ? "Сервер не вернул моделей, разрешённых этому ключу."
        : undefined,
      unavailable.length
        ? `Не показываются модели: ${unavailable.join("; ")}`
        : undefined,
    ];
    status.tooltip = credentials.connected
      ? tooltip.filter(Boolean).join("\n") ||
        "API-ключ сохранён. Управление подключением Врата AI"
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
  command("vrata.debugStaging", async () => {
    if (!credentials.connected || !credentials.key)
      throw new CredentialError("Врата AI не подключены. Вставьте API-ключ.");
    const staging = new GatewayClient(
      fetch,
      (message) => output.info("[staging] " + message),
      STAGING_API_ORIGIN,
    );
    const catalog = await staging.models(
      credentials.key,
      new AbortController().signal,
    );
    const { models, unavailable } = projectCatalog(catalog);
    output.info(
      "[staging] Каталог получен: доступно моделей " +
        models.length +
        "; пропущено " +
        unavailable.length +
        ".",
    );
    await vscode.window.showInformationMessage(
      "Staging-проверка завершена. Доступно моделей: " + models.length + ".",
    );
  });
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
        .showInformationMessage(
          "API-ключ сохранён. Выберите модель Врат AI в меню моделей чата (Chat → Manage Models).",
        )
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
  command("vrata.refreshModels", async () => {
    if (!credentials.connected) return;
    await credentials.loadCatalog(true);
    const { models, unavailable } = projectCatalog(credentials.catalog);
    await vscode.window.showInformationMessage(
      `Каталог Врат AI обновлён. Доступно моделей: ${models.length}.${
        unavailable.length ? ` Не показываются: ${unavailable.join("; ")}` : ""
      }`,
    );
  });
  command("vrata.refreshBalance", async (keys) => {
    if (!credentials.connected) return;
    try {
      await credentials.loadAccount();
    } catch (error) {
      logError(error, ...keys);
      await showError(
        error instanceof AccountError && error.status === 401
          ? "Ключ Врат AI недействителен. Замените его."
          : "Не удалось обновить баланс Врат AI. Последнее значение помечено как устаревшее.",
      );
    }
  });
  command("vrata.copyDiagnostics", async () => {
    await vscode.env.clipboard.writeText(
      diagnosticReport({
        editorVersion: vscode.version,
        extensionVersion: String(
          context.extension?.packageJSON?.version ?? "unknown",
        ),
        ...lastDiagnostic,
      }),
    );
    await vscode.window.showInformationMessage(
      "Диагностика Врат AI скопирована.",
    );
  });
  command("vrata.getApiKey", () =>
    vscode.env.openExternal(vscode.Uri.parse(BOT_URL)),
  );
  const panel = new VrataPanel(context, credentials, (error) =>
    logError(error),
  );
  context.subscriptions.push(
    panel,
    ...registerPanelCommands(
      panel,
      () => projectCatalog(credentials.catalog).models,
    ),
    vscode.window.registerTreeDataProvider("vrata.panel", panel),
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
        { label: "Выбрать модель", command: "vrata.selectModel" },
        { label: "Выбрать reasoning level", command: "vrata.selectReasoning" },
        { label: "Пополнить баланс / открыть бот", command: "vrata.getApiKey" },
        ...(credentials.connected
          ? [
              { label: "Обновить баланс", command: "vrata.refreshBalance" },
              {
                label: "Обновить список моделей",
                command: "vrata.refreshModels",
              },
              { label: "Удалить ключ", command: "vrata.removeApiKey" },
            ]
          : []),
        { label: "Открыть журнал", command: "vrata.showLogs" },
        { label: "Проверить staging-каталог", command: "vrata.debugStaging" },
        { label: "Скопировать диагностику", command: "vrata.copyDiagnostics" },
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
    void showError("Не удалось прочитать ключ Врат AI. Повторите подключение.");
  }
  updateStatus();
  status.show();

  void vscode.commands
    .executeCommand(
      "setContext",
      "vrata.copilotChatAvailable",
      vscode.extensions.getExtension("GitHub.copilot-chat") !== undefined,
    )
    .then(undefined, (error: unknown) => logError(error));

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
        } catch (error) {
          logError(error, key);
        }
        if (token.isCancellationRequested) return [];
        const { models } = projectCatalog(credentials.catalog);
        return models.map((model) =>
          credentials.catalogStale
            ? {
                ...model,
                detail: "Каталог устарел",
                tooltip:
                  "Последнее обновление каталога не удалось. Ограничения проверяются сервером при запросе.",
              }
            : model,
        );
      },
      async provideTokenCount(_model, input) {
        try {
          return estimateTokens(
            typeof input === "string" ? input : toMessages([input]),
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
              const messagesTransport =
                projectCatalog(credentials.catalog).transports[model.id] ===
                "messages";
              const requestId = await (
                messagesTransport ? streamMessages : streamChat
              )(
                `${API_ORIGIN}${messagesTransport ? "/v1/messages" : "/v1/chat/completions"}`,
                session.key,
                messagesTransport
                  ? {
                      model: model.id,
                      messages: toAnthropicMessages(toMessages(messages)),
                      max_tokens: model.maxOutputTokens,
                      ...(options.tools?.length
                        ? {
                            tools: options.tools.map((tool) => ({
                              name: tool.name,
                              description: tool.description,
                              input_schema: tool.inputSchema ?? {
                                type: "object",
                                properties: {},
                              },
                            })),
                            tool_choice: {
                              type:
                                options.toolMode ===
                                vscode.LanguageModelChatToolMode.Required
                                  ? "any"
                                  : "auto",
                            },
                          }
                        : {}),
                    }
                  : {
                      model: model.id,
                      messages: toMessages(messages),
                      max_tokens: model.maxOutputTokens,
                      ...chatCompletionsReasoning(
                        resolveReasoning(options, panel.reasoning),
                      ),
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
              lastDiagnostic = { modelId: model.id, requestId };
            } finally {
              subscription.dispose();
              if (session.isCurrent())
                void credentials
                  .loadAccount()
                  .catch((error) => logError(error, session.key));
            }
          });
        } catch (error) {
          if (signal?.aborted) throw new vscode.CancellationError();
          logError(error, key);
          const detail = requestError(error);
          lastDiagnostic = {
            modelId: model.id,
            code: detail.code,
            requestId: detail.requestId,
          };
          notifyRequestFailure(detail);
          // eslint-disable-next-line preserve-caught-error -- The original is logged above; its cause may expose a key to the editor.
          throw new Error(detail.message);
        }
      },
    }),
  );
  if (!context.globalState.get<boolean>("welcomeShown")) {
    await vscode.commands.executeCommand("vrata.openWalkthrough");
    await context.globalState.update("welcomeShown", true);
  }
}
