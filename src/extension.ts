import * as vscode from "vscode";
import { diagnosticReport, formatError } from "./diagnostics";
import { Message, MessageContentPart, streamChat } from "./transport";
import { streamMessages, toAnthropicMessages } from "./messages-transport";
import { streamResponses, toResponsesInput } from "./responses-transport";
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
  API_ORIGIN,
  STAGING_API_ORIGIN,
  BOT_URL,
  CredentialError,
  GatewayClient,
} from "./gateway";
import { VrataPanel, registerPanelCommands } from "./panel";
import { resolveReasoning } from "./reasoning";
import { modelPickerTabsEnabled } from "./welcome";

const MODEL_PICKER_CATEGORY_LABEL = "Врата AI";

function providerIconPath(extensionUri: vscode.Uri): vscode.Uri | undefined {
  const minor = Number(vscode.version.split(".")[1] ?? 0);
  return minor >= 106
    ? vscode.Uri.joinPath(extensionUri, "media", "vrata.svg")
    : undefined;
}

function modelPickerCategory(): string | { label: string; order: number } {
  const minor = Number(vscode.version.split(".")[1] ?? 0);
  return minor >= 126
    ? MODEL_PICKER_CATEGORY_LABEL
    : { label: MODEL_PICKER_CATEGORY_LABEL, order: 0 };
}

function text(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) return part.value;
      throw new Error("Vrata supports text tool results only");
    })
    .join("\n");
}

function imagePart(part: unknown): MessageContentPart | undefined {
  if (!part || typeof part !== "object") return undefined;
  const value = part as { data?: unknown; mimeType?: unknown };
  if (value.data === undefined && value.mimeType === undefined)
    return undefined;
  if (
    typeof value.mimeType !== "string" ||
    !/^image\/(png|jpeg|gif|webp)$/i.test(value.mimeType) ||
    !(value.data instanceof Uint8Array)
  )
    throw new Error("Vrata supports PNG, JPEG, GIF and WebP images only");
  return {
    type: "image_url",
    image_url: {
      url: `data:${value.mimeType};base64,${Buffer.from(value.data).toString("base64")}`,
    },
  };
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
    const contentParts: MessageContentPart[] = [];
    let hasImage = false;
    const calls: NonNullable<Message["tool_calls"]> = [];
    const appendText = (value: string) => {
      if (hasImage) contentParts.push({ type: "text", text: value });
      else content += value;
    };
    const flush = () => {
      if (content || contentParts.length || calls.length)
        result.push({
          role,
          content: hasImage ? [...contentParts] : content || null,
          ...(calls.length ? { tool_calls: [...calls] } : {}),
        });
      content = "";
      contentParts.length = 0;
      hasImage = false;
      calls.length = 0;
    };
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) appendText(part.value);
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
      } else {
        const image = imagePart(part);
        if (!image)
          throw new Error("Vrata supports text, image and tool parts only");
        if (!hasImage) {
          if (content) contentParts.push({ type: "text", text: content });
          content = "";
          hasImage = true;
        }
        contentParts.push(image);
      }
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
    if (account && !credentials.accountInvalid) {
      status.text = `$(key) Врата AI: ${rubles(account.balance.spendable)}`;
      status.show();
    } else {
      status.hide();
    }
    const tooltip = [
      account && !credentials.accountInvalid
        ? accountTooltip(account)
        : undefined,
      credentials.accountInvalid
        ? "Ключ недействителен. Замените его."
        : undefined,
      credentials.accountUnavailable && !credentials.accountInvalid
        ? "Не удалось получить баланс. Он обновится после следующего запроса."
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
              ? "Не удалось проверить API-ключ. Проверьте ключ и соединение."
              : "Не удалось выполнить команду Врат AI.";
          await showError(message);
        }
      }),
    );
  }
  command("vrata.showLogs", () => output.show(true));
  command("vrata.debugStaging", async () => {
    const staging = new GatewayClient(
      fetch,
      (message) => output.info("[staging] " + message),
      STAGING_API_ORIGIN,
    );
    await credentials.run(async (session) => {
      const catalog = await staging.models(session.key, session.signal);
      if (!session.isCurrent()) throw new CredentialOperationCancelled();
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
          "API-ключ сохранён. Откройте выбор модели и выберите Врата AI.",
          "Выбрать модель",
        )
        .then((choice) => {
          if (choice === "Выбрать модель")
            return vscode.commands.executeCommand("vrata.openModelPicker");
          return undefined;
        })
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
  const panel = new VrataPanel(context, credentials);
  panel.onExternalChange = () => changes.fire();
  registerPanelCommands(
    panel,
    () => projectCatalog(credentials.catalog).models,
    command,
  );
  context.subscriptions.push(
    panel,
    vscode.window.registerTreeDataProvider("vrata.panel", panel),
  );
  function openWalkthrough(): Thenable<unknown> {
    const open = () =>
      vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        `${context.extension.id}#vrata.welcome`,
        false,
      );
    const result = open();
    for (const delay of [250, 1000]) {
      setTimeout(() => {
        void open().then(undefined, (error) => logError(error));
      }, delay);
    }
    return result;
  }
  command("vrata.openWalkthrough", () => openWalkthrough());
  command("vrata.utilitySettings", () => {
    const setting = vscode.workspace
      .getConfiguration("chat")
      .inspect<string>("byokUtilityModelDefault");
    if (setting?.defaultValue === undefined) {
      return vscode.window.showInformationMessage(
        "Настройка фоновой модели недоступна в этой версии VS Code. Обновите редактор, чтобы выбрать модель Врат AI для названий чатов и других служебных запросов.",
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
        { label: "Пополнить баланс / открыть бот", command: "vrata.getApiKey" },
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
    await credentials.reload();
  } catch (error) {
    logError(error);
    void showError("Не удалось прочитать ключ Врат AI. Повторите подключение.");
  }
  updateStatus();

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("vrata", {
      onDidChangeLanguageModelChatInformation: changes.event,
      async provideLanguageModelChatInformation(options, token) {
        let key = credentials.key;
        try {
          if (token.isCancellationRequested) return [];
          if (!options.silent)
            await vscode.commands.executeCommand("vrata.manage");
          if (!credentials.connected || token.isCancellationRequested)
            return [];
          key = credentials.key;
          await credentials.loadCatalog();
        } catch (error) {
          logError(error, key);
        }
        if (token.isCancellationRequested) return [];
        const { models } = projectCatalog(credentials.catalog);
        const icon = providerIconPath(context.extensionUri);
        return models.map((model) => ({
          ...model,
          category: modelPickerCategory(),
          ...(icon ? { icon } : {}),
          ...(credentials.catalogStale
            ? {
                detail: "Каталог устарел",
                tooltip:
                  "Последнее обновление каталога не удалось. Ограничения проверяются сервером при запросе.",
              }
            : {}),
        }));
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
              const catalog = projectCatalog(credentials.catalog);
              const targetId = model.id;
              const transport =
                catalog.transports[targetId] ?? "chat_completions";
              const effort = resolveReasoning(options, panel.reasoning);
              output.info(
                `Запрос: модель ${targetId}, транспорт ${transport}, reasoning_effort ${effort ?? "не задан (по умолчанию сервера)"}.`,
              );
              let endpoint = `${API_ORIGIN}/v1/chat/completions`;
              let stream = streamChat;
              if (transport === "messages") {
                endpoint = `${API_ORIGIN}/v1/messages`;
                stream = streamMessages;
              } else if (transport === "responses") {
                endpoint = `${API_ORIGIN}/v1/responses`;
                stream = streamResponses;
              }
              const convertedMessages = toMessages(messages);
              let requestBody: object;
              if (transport === "messages") {
                requestBody = {
                  model: targetId,
                  messages: toAnthropicMessages(convertedMessages),
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
                };
              } else if (transport === "responses") {
                requestBody = {
                  model: targetId,
                  input: toResponsesInput(convertedMessages),
                  max_output_tokens: model.maxOutputTokens,
                  ...(effort ? { reasoning: { effort } } : {}),
                  ...(options.tools?.length
                    ? {
                        tools: options.tools.map((tool) => ({
                          type: "function",
                          name: tool.name,
                          description: tool.description,
                          parameters: tool.inputSchema ?? {
                            type: "object",
                            properties: {},
                          },
                        })),
                        tool_choice:
                          options.toolMode ===
                          vscode.LanguageModelChatToolMode.Required
                            ? "required"
                            : "auto",
                      }
                    : {}),
                };
              } else {
                requestBody = {
                  model: targetId,
                  messages: convertedMessages,
                  max_tokens: model.maxOutputTokens,
                  ...(effort ? { reasoning_effort: effort } : {}),
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
                };
              }
              const requestId = await stream(
                endpoint,
                session.key,
                requestBody,
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
              if (session.isCurrent() && !signal.aborted)
                lastDiagnostic = { modelId: model.id, requestId };
            } finally {
              subscription.dispose();
              if (session.isCurrent())
                await credentials
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
          const publicError = new Error(detail.message);
          throw publicError;
        }
      },
    }),
  );
  try {
    const chatConfiguration = vscode.workspace.getConfiguration("chat");
    await vscode.commands.executeCommand(
      "setContext",
      "vrata.modelPickerTabs",
      modelPickerTabsEnabled(vscode.version, chatConfiguration),
    );
  } catch (error) {
    logError(error);
  }
  if (!context.globalState.get<boolean>("welcomeShown")) {
    await context.globalState.update("welcomeShown", true);
    setTimeout(() => {
      void openWalkthrough().then(undefined, (error) => logError(error));
    }, 0);
  }
}
