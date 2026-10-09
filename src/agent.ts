import * as vscode from "vscode";

export interface VrataAgentDeps {
  /** Preferred model id chosen in the panel; empty means the chat default. */
  modelId(): string | undefined;
  /** Stored reasoning level; undefined means the server default. */
  reasoning(): string | undefined;
  logError(error: unknown): void;
}

/**
 * Built-in chat participant "@vrata": a working coding-agent loop on the
 * editor's own chat UI. It never uses Copilot internals or undocumented
 * APIs: the loop is vscode.lm.sendRequest plus vscode.lm.invokeTool, so it
 * works in plain VS Code without the Copilot extensions.
 */
export function registerVrataAgent(deps: VrataAgentDeps): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    "vrata.agent",
    async (request, context, response, token) => {
      const model = await resolveModel(deps, request.model);
      const messages = [...historyMessages(context.history)];
      messages.push(
        request.prompt
          ? vscode.LanguageModelChatMessage.User(request.prompt)
          : vscode.LanguageModelChatMessage.User(
              "Продолжай работу над текущей задачей.",
            ),
      );
      const options: vscode.LanguageModelChatRequestOptions = {
        modelOptions: {
          reasoningEffort: normalizeEffort(deps.reasoning()),
        },
      };
      for (let step = 0; step < MAX_STEPS; step++) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const chat = await model.sendRequest(messages, options, token);
        const calls: vscode.LanguageModelToolCallPart[] = [];
        for await (const part of chat.stream) {
          if (part instanceof vscode.LanguageModelTextPart)
            response.markdown(part.value);
          else if (part instanceof vscode.LanguageModelToolCallPart) {
            calls.push(part);
            await response.push(
              new vscode.ChatResponseProgressPart(`Инструмент ${part.name}…`),
            );
          }
        }
        if (!calls.length) break;
        messages.push(
          vscode.LanguageModelChatMessage.Assistant(
            calls.map(
              (call) =>
                new vscode.LanguageModelToolCallPart(
                  call.callId,
                  call.name,
                  call.input,
                ),
            ),
          ),
        );
        for (const call of calls) {
          if (token.isCancellationRequested)
            throw new vscode.CancellationError();
          const result = await vscode.lm.invokeTool(
            call.name,
            {
              input: call.input,
              toolInvocationToken: request.toolInvocationToken,
            },
            token,
          );
          messages.push(
            vscode.LanguageModelChatMessage.User([
              new vscode.LanguageModelToolResultPart(call.callId, [
                ...result.content,
              ]),
            ]),
          );
        }
      }
      return {
        metadata: { model: model.id, reasoning: deps.reasoning() ?? null },
      };
    },
  );
  return participant;
}

const MAX_STEPS = 16;

function normalizeEffort(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value;
}

async function resolveModel(
  deps: VrataAgentDeps,
  fallback: vscode.LanguageModelChat | undefined,
): Promise<vscode.LanguageModelChat> {
  const id = deps.modelId();
  if (id) {
    try {
      const matches = await vscode.lm.selectChatModels({
        vendor: "vrata",
        id,
      });
      if (matches.length) return matches[0]!;
    } catch (error) {
      deps.logError(error);
    }
  }
  if (!fallback)
    throw new Error(
      "Модель Врат AI недоступна. Подключите ключ и выберите модель в панели.",
    );
  return fallback;
}

function historyMessages(
  history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];
  for (const turn of history) {
    if ("prompt" in turn) {
      if (turn.prompt)
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      continue;
    }
    const text = turn.response
      .filter((part) => part instanceof vscode.ChatResponseMarkdownPart)
      .map((part) => (part as vscode.ChatResponseMarkdownPart).value.value)
      .join("\n")
      .trim();
    if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
  }
  return messages;
}
